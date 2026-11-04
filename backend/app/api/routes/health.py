"""健康检查接口。

提供三个互相独立的探针，便于容器编排、负载均衡、监控系统和前端联调
分别判断后端进程与外部依赖的状态：

- ``GET /api/health``：后端进程是否可以正常处理请求，不访问任何外部依赖；
- ``GET /api/health/database``：PostgreSQL 是否可连接并可执行查询；
- ``GET /api/health/cos``：腾讯云 COS 是否可访问（校验配置、鉴权、网络与存储桶）。

每个接口都显式声明了 ``operation_id``，前端类型生成工具（例如
``@hey-api/openapi-ts``、``openapi-typescript``）会据此生成对应的函数名：

==========================  ============================  ==================
operation_id                生成的函数名                   检查对象
==========================  ============================  ==================
``healthCheck``            ``healthCheck``               后端服务自身
``healthCheckDatabase``   ``healthCheckDatabase``       数据库
``healthCheckCos``        ``healthCheckCos``            COS
==========================  ============================  ==================

依赖组件不可用时统一返回 ``503 Service Unavailable``，响应体沿用项目统一的
``{code, message, details}`` 错误结构；探针本身只要进程能处理请求就返回 200。
"""

from datetime import UTC, datetime
from http import HTTPStatus
from time import perf_counter
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.api.deps import DbSession
from app.core.config import settings
from app.core.exceptions import AppException
from app.core.logging import get_logger
from app.storage.cos_client import COSClient, get_cos_client

logger = get_logger(__name__)

router = APIRouter(prefix="/health", tags=["health"])


class HealthCheckResponse(BaseModel):
    """后端服务自身健康检查结果。"""

    status: Literal["ok"] = Field(
        default="ok",
        description="健康状态，服务可正常处理请求时固定为 ok",
    )
    service: str = Field(description="服务名称，取自 APP_NAME 配置")
    message: str = Field(description="健康状态说明")
    timestamp: datetime = Field(description="检查时间（UTC，ISO 8601）")


class ComponentHealthResponse(BaseModel):
    """外部依赖（数据库 / COS）连通性检查结果。"""

    status: Literal["ok"] = Field(
        default="ok",
        description="健康状态，依赖可正常访问时固定为 ok",
    )
    component: Literal["database", "cos"] = Field(
        description="被检查的组件名称",
    )
    message: str = Field(description="健康状态说明")
    latency_ms: float = Field(
        description="本次检查耗时（毫秒，保留两位小数）",
    )
    timestamp: datetime = Field(description="检查时间（UTC，ISO 8601）")


class HealthCheckFailedError(AppException):
    """健康检查未通过：被检查的依赖组件不可用。"""

    code = "health_check_failed"
    message = "健康检查未通过"
    http_status = HTTPStatus.SERVICE_UNAVAILABLE


def _elapsed_ms(started: float) -> float:
    """返回自 ``started`` 起经过的毫秒数，保留两位小数。"""
    return round((perf_counter() - started) * 1000, 2)


@router.get(
    "",
    response_model=HealthCheckResponse,
    operation_id="healthCheck",
    summary="后端服务健康检查",
    description=(
        "确认 FastAPI 进程已启动并能正常处理请求。"
        "该探针不访问数据库或 COS，适合用作存活探针（liveness probe）。"
    ),
)
async def health_check() -> HealthCheckResponse:
    """返回服务自身的存活状态。"""
    return HealthCheckResponse(
        status="ok",
        service=settings.app_name,
        message="服务运行正常",
        timestamp=datetime.now(UTC),
    )


@router.get(
    "/database",
    response_model=ComponentHealthResponse,
    operation_id="healthCheckDatabase",
    summary="数据库连通性检查",
    description=(
        "对 PostgreSQL 执行 ``SELECT 1``，验证连接串、网络与数据库实例是否可用。"
        "连接失败或查询失败时返回 503。"
    ),
    responses={
        HTTPStatus.SERVICE_UNAVAILABLE: {
            "description": "数据库不可用",
            "content": {
                "application/json": {
                    "example": {
                        "code": "health_check_database_failed",
                        "message": "数据库健康检查失败",
                        "details": {"component": "database", "latency_ms": 12.34},
                    }
                }
            },
        }
    },
)
async def health_check_database(session: DbSession) -> ComponentHealthResponse:
    """执行 ``SELECT 1`` 验证数据库连通性。"""
    started = perf_counter()
    try:
        await session.execute(text("SELECT 1"))
    except Exception as exc:
        latency_ms = _elapsed_ms(started)
        # 完整异常仅写入服务端日志，响应中不暴露连接串、SQL 等内部细节。
        logger.warning("数据库健康检查失败: %s: %s", type(exc).__name__, exc)
        raise HealthCheckFailedError(
            "数据库健康检查失败",
            code="health_check_database_failed",
            details={"component": "database", "latency_ms": latency_ms},
        ) from exc

    return ComponentHealthResponse(
        status="ok",
        component="database",
        message="数据库连接正常",
        latency_ms=_elapsed_ms(started),
        timestamp=datetime.now(UTC),
    )


@router.get(
    "/cos",
    response_model=ComponentHealthResponse,
    operation_id="healthCheckCos",
    summary="COS 连通性检查",
    description=(
        "调用 COS ``ListObjects``（最多读取 1 个对象）验证配置、鉴权、"
        "网络与存储桶是否可用。未配置 COS_* 或调用失败时返回 503。"
    ),
    responses={
        HTTPStatus.SERVICE_UNAVAILABLE: {
            "description": "COS 不可用或未配置",
            "content": {
                "application/json": {
                    "example": {
                        "code": "health_check_cos_failed",
                        "message": "COS 健康检查失败",
                        "details": {"component": "cos", "latency_ms": 12.34},
                    }
                }
            },
        }
    },
)
async def health_check_cos(
    cos: Annotated[COSClient, Depends(get_cos_client)],
) -> ComponentHealthResponse:
    """调用 ``list_objects`` 验证 COS 连通性。"""
    started = perf_counter()
    try:
        await cos.list_objects(max_keys=1)
    except Exception as exc:
        latency_ms = _elapsed_ms(started)
        # AppException 的 code 更具体（如 configuration_error / cos_error），
        # 放入 details 方便排查；对外仍统一为健康检查失败的 503 响应。
        reason = getattr(exc, "code", type(exc).__name__)
        logger.warning("COS 健康检查失败: %s: %s", type(exc).__name__, exc)
        raise HealthCheckFailedError(
            "COS 健康检查失败",
            code="health_check_cos_failed",
            details={
                "component": "cos",
                "latency_ms": latency_ms,
                "reason": reason,
            },
        ) from exc

    return ComponentHealthResponse(
        status="ok",
        component="cos",
        message="COS 连接正常",
        latency_ms=_elapsed_ms(started),
        timestamp=datetime.now(UTC),
    )
