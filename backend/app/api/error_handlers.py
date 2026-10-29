"""FastAPI 全局异常处理。

把各类异常统一转换为 ``{code, message, details}`` 结构的 JSON 响应，
使前端只需要处理一种错误格式：

- :class:`app.core.exceptions.AppException` 及其子类：使用异常自带的
  ``code`` / ``message`` / ``details`` 与 HTTP 状态码。
- 请求参数校验失败（``RequestValidationError``）：返回 422，并在
  ``details`` 中给出逐字段的校验信息。
- 其它 ``HTTPException``（如路由不存在、依赖中抛出的 401/403）：
  转换为同一结构，同时保留原始响应头（例如 ``WWW-Authenticate``）。
- 未预期异常：统一返回 500 与通用文案，完整堆栈仅写入服务端日志，
  不会把文件路径、SQL、变量值等内部细节泄露给前端。

在应用入口处调用 :func:`register_exception_handlers` 完成注册::

    app = FastAPI()
    register_exception_handlers(app)
"""

from collections.abc import Mapping
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.exceptions import AppException
from app.core.logging import get_logger

logger = get_logger(__name__)

_INTERNAL_ERROR_CODE = "internal_error"
_INTERNAL_ERROR_MESSAGE = "服务内部错误"
_VALIDATION_ERROR_CODE = "unprocessable_entity"
_VALIDATION_ERROR_MESSAGE = "请求参数校验失败"

# 与 app.core.exceptions 中的业务异常保持同一套 code 语义
_STATUS_CODE_MAP: dict[int, str] = {
    HTTPStatus.BAD_REQUEST: "bad_request",
    HTTPStatus.UNAUTHORIZED: "unauthorized",
    HTTPStatus.FORBIDDEN: "permission_denied",
    HTTPStatus.NOT_FOUND: "not_found",
    HTTPStatus.METHOD_NOT_ALLOWED: "method_not_allowed",
    HTTPStatus.CONFLICT: "conflict",
    HTTPStatus.UNPROCESSABLE_ENTITY: "unprocessable_entity",
    HTTPStatus.TOO_MANY_REQUESTS: "too_many_requests",
    HTTPStatus.INTERNAL_SERVER_ERROR: "internal_error",
    HTTPStatus.SERVICE_UNAVAILABLE: "service_unavailable",
}

# 未显式提供 detail 时使用的中文默认文案
_STATUS_MESSAGE_MAP: dict[int, str] = {
    HTTPStatus.BAD_REQUEST: "请求参数错误",
    HTTPStatus.UNAUTHORIZED: "未登录或登录已失效",
    HTTPStatus.FORBIDDEN: "无权访问该资源",
    HTTPStatus.NOT_FOUND: "资源不存在",
    HTTPStatus.METHOD_NOT_ALLOWED: "请求方法不被允许",
    HTTPStatus.CONFLICT: "资源冲突",
    HTTPStatus.UNPROCESSABLE_ENTITY: "请求内容无法处理",
    HTTPStatus.TOO_MANY_REQUESTS: "请求过于频繁，请稍后再试",
    HTTPStatus.INTERNAL_SERVER_ERROR: "服务内部错误",
    HTTPStatus.SERVICE_UNAVAILABLE: "服务暂时不可用",
}


def _safe_status_name(status_code: int) -> str:
    """返回 ``not_found`` 这类由状态码推导出的 code，未知状态码回退。"""
    try:
        return HTTPStatus(status_code).name.lower()
    except ValueError:
        return "http_error"


def _status_phrase(status_code: int) -> str:
    """返回标准状态短语（如 ``Not Found``），未知状态码返回空串。"""
    try:
        return HTTPStatus(status_code).phrase
    except ValueError:
        return ""


def _resolve_http_error(exc: StarletteHTTPException) -> tuple[str, str, Any]:
    """把 ``HTTPException`` 转换成 ``(code, message, details)``。

    ``detail`` 为字符串时直接作为 ``message``；但 Starlette 在路由 404 等
    场景会填入默认英文短语（如 ``Not Found``），此时改用中文默认文案。
    非字符串 ``detail`` 则放入 ``details``，避免 ``message`` 类型不统一。
    """
    status_code = exc.status_code
    code = _STATUS_CODE_MAP.get(status_code, _safe_status_name(status_code))
    default_message = _STATUS_MESSAGE_MAP.get(
        status_code, _status_phrase(status_code) or "请求失败"
    )

    detail = exc.detail
    if isinstance(detail, str):
        message = default_message if detail == _status_phrase(status_code) else detail
        return code, message or default_message, None
    return code, default_message, jsonable_encoder(detail)


def _error_response(
    *,
    status_code: int,
    code: str,
    message: str,
    details: Any = None,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    """构造统一错误响应。"""
    return JSONResponse(
        status_code=status_code,
        content={"code": code, "message": message, "details": details},
        headers=headers,
    )


async def app_exception_handler(request: Request, exc: AppException) -> JSONResponse:
    """处理所有业务异常。"""
    status_code = int(exc.http_status)
    if status_code >= HTTPStatus.INTERNAL_SERVER_ERROR:
        # 5xx 属于服务端问题，记录完整堆栈便于排查
        logger.exception(
            "业务异常: %s %s | code=%s", request.method, request.url.path, exc.code
        )
    else:
        # 4xx 是预期的客户端错误，只记录必要上下文
        logger.info(
            "业务异常: %s %s | code=%s | message=%s",
            request.method,
            request.url.path,
            exc.code,
            exc.message,
        )
    return _error_response(
        status_code=status_code,
        code=exc.code,
        message=exc.message,
        details=exc.details,
    )


async def http_exception_handler(
    request: Request, exc: StarletteHTTPException
) -> JSONResponse:
    """处理 FastAPI / Starlette 或依赖中抛出的 ``HTTPException``。"""
    code, message, details = _resolve_http_error(exc)
    if exc.status_code >= HTTPStatus.INTERNAL_SERVER_ERROR:
        logger.exception(
            "HTTP 异常: %s %s | status=%s",
            request.method,
            request.url.path,
            exc.status_code,
        )
    else:
        logger.debug(
            "HTTP 异常: %s %s | status=%s",
            request.method,
            request.url.path,
            exc.status_code,
        )
    return _error_response(
        status_code=exc.status_code,
        code=code,
        message=message,
        details=details,
        headers=exc.headers,
    )


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """处理请求参数校验失败，返回 422 与逐字段错误明细。"""
    logger.debug("参数校验失败: %s %s", request.method, request.url.path)
    return _error_response(
        status_code=HTTPStatus.UNPROCESSABLE_ENTITY,
        code=_VALIDATION_ERROR_CODE,
        message=_VALIDATION_ERROR_MESSAGE,
        details=jsonable_encoder(exc.errors()),
    )


async def unhandled_exception_handler(
    request: Request, exc: Exception
) -> JSONResponse:
    """兜底处理未预期异常。

    完整异常与堆栈只写入服务端日志；响应体使用固定文案且不包含
    ``details``，避免内部实现细节泄露给前端。
    """
    logger.exception(
        "未处理异常: %s %s | type=%s",
        request.method,
        request.url.path,
        type(exc).__name__,
    )
    return _error_response(
        status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
        code=_INTERNAL_ERROR_CODE,
        message=_INTERNAL_ERROR_MESSAGE,
    )


def register_exception_handlers(app: FastAPI) -> None:
    """把全局异常处理器注册到 FastAPI 应用。

    重复调用只会覆盖同名处理器，不会产生额外副作用。注册顺序不影响
    匹配结果：Starlette 按异常类的 MRO 查找，``Exception`` 处理器由
    ``ServerErrorMiddleware`` 负责兜底。
    """
    app.add_exception_handler(AppException, app_exception_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
