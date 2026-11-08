"""应用入口：配置生命周期、中间件、异常处理和路由。

在 backend 目录执行 `uvicorn app.main:app --reload` 启动服务。
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.error_handlers import register_exception_handlers
from app.api.routes import documents, health, chat
from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.db.session import engine

API_PREFIX = "/api"
APP_VERSION = "0.1.0"

configure_logging()
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """启动时记录配置状态，关闭时释放数据库连接池。"""
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
    """组装应用；测试可独立创建实例，uvicorn 使用下方 app 单例。"""
    app = FastAPI(
        title=settings.app_name,
        version=APP_VERSION,
        description="RAG 知识库后端，提供健康检查、文档管理与分块查询接口。",
        lifespan=lifespan,
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=f"{API_PREFIX}/redoc",
        openapi_url=f"{API_PREFIX}/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_exception_handlers(app)

    # 全局前缀只在应用入口添加，路由模块仅定义资源前缀。
    app.include_router(health.router, prefix=API_PREFIX)
    app.include_router(documents.router, prefix=API_PREFIX)
    app.include_router(chat.router, prefix=API_PREFIX)
    return app


app = create_app()
