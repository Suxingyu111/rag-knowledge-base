"""FastAPI 应用入口。

本模块负责把项目各基础模块组装成一个可运行的 FastAPI 应用，是
``uvicorn app.main:app`` 的挂载点。组装顺序如下：

1. :func:`app.core.logging.configure_logging`：在创建应用前配置日志，
   保证启动过程与请求日志使用统一的格式和级别。
2. ``lifespan``：记录启动信息、提示缺失配置，并在进程退出时释放
   数据库连接池。
3. :class:`fastapi.FastAPI`：统一标题、版本、OpenAPI 文档地址。
4. ``CORSMiddleware``：允许配置中的前端域名跨域访问。
5. :func:`app.api.error_handlers.register_exception_handlers`：注册全局
   异常处理，保证所有错误响应都是 ``{code, message, details}``。
6. 业务路由：当前仅有健康检查 ``app.api.routes.health``，后续新增路由
   在此处 ``include_router`` 即可。

启动方式::

    cd backend
    uvicorn app.main:app --reload

文档地址：

- Swagger UI：``/api/docs``
- ReDoc：``/api/redoc``
- OpenAPI JSON：``/api/openapi.json``（前端类型生成工具使用该地址）
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.error_handlers import register_exception_handlers
from app.api.routes import health
from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.db.session import engine

# 必须在其它模块产生日志之前完成配置，否则会先输出默认格式的日志。
configure_logging()

logger = get_logger(__name__)

APP_VERSION = "0.1.0"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """应用生命周期钩子。

    启动阶段只记录状态、不做强依赖校验：数据库或 COS 暂不可用时应用
    仍应能启动，由 ``/api/health/*`` 探针暴露具体问题。关闭阶段释放
    数据库连接池，避免测试或多进程重启时残留连接。
    """
    logger.info("应用启动: %s v%s", settings.app_name, APP_VERSION)

    if not settings.cos_configured:
        logger.warning(
            "COS 未配置，/api/health/cos 将返回 503；请检查 .env 中的 COS_* 变量"
        )

    try:
        yield
    finally:
        await engine.dispose()
        logger.info("应用关闭，数据库连接池已释放")


def create_app() -> FastAPI:
    """创建并组装 FastAPI 应用。

    独立成函数便于测试：测试中可以按需多次构建应用，而模块级 ``app``
    始终是供 uvicorn 使用的单例。
    """
    app = FastAPI(
        title=settings.app_name,
        version=APP_VERSION,
        description="RAG 知识库后端服务，统一提供健康检查与后续业务接口。",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )

    # 跨域：来源列表由 CORS_ORIGINS 以逗号分隔配置，默认仅允许本地前端。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 全局异常处理需要在挂载路由前注册，保证路由内抛出的异常也会被捕获。
    register_exception_handlers(app)

    # 各路由模块自带 /api 前缀，这里不要重复叠加。
    app.include_router(health.router)

    return app


app = create_app()
