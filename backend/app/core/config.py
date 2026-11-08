"""全局配置。

配置来源优先级（从高到低）：

1. 进程环境变量（例如 ``APP_NAME=xxx uvicorn app.main:app``）
2. 项目根目录下的 ``.env`` 文件
3. 本类中定义的默认值

``.env`` 中未在 :class:`Settings` 声明的变量会被直接忽略（``extra="ignore"``），
因此同一个 ``.env`` 可以同时存放 Docker Compose、前端等其它工具使用的变量，
不会因为多余变量导致启动失败。
"""

from functools import lru_cache
from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/core/config.py -> parents[3] 即项目根目录
PROJECT_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = PROJECT_ROOT / ".env"


class Settings(BaseSettings):
    """项目自定义配置类，全项目统一通过 ``settings`` 单例读取。"""

    model_config = SettingsConfigDict(
        # 使用绝对路径，保证无论从哪个工作目录启动进程都能读到同一个 .env
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        # 字段名不区分大小写：APP_NAME / app_name 都能映射到 app_name
        case_sensitive=False,
        # 忽略 .env 及系统环境中未声明的多余变量
        extra="ignore",
    )

    # ---- 应用 ----
    app_name: str = "rag-knowledge-base"
    log_level: str = "INFO"

    # ---- PostgreSQL ----
    postgres_user: str = ""
    postgres_password: str = ""
    postgres_db: str = ""
    postgres_port: int = 5432

    # 完整连接串；.env 中未显式提供时，由上面的 POSTGRES_* 自动拼接
    database_url: str = ""

    cos_secret_id: str = ""
    cos_secret_key: str = ""
    cos_region: str = "ap-guangzhou"
    cos_bucket: str = ""

    cors_origins: str = "http://localhost:5173"

    embedding_api_key: str = ""
    enbeding_base_url: str = "https://ws-j9yvjavs76o44pca.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    embedding_model: str = "qwen3.7-text-embedding"
    embedding_dim: int = 1024
    embedding_batch_size: int = 10

    upload_max_size_mb: int = 50
    document_parse_timeout_seconds: float = Field(default=180, gt=0)
    chunk_size: int = 600
    chunk_overlap: int = 60

    # === Chat 模型(DashScope OpenAI 兼容协议) ===
    # 默认与 embedding 同 base_url
    chat_api_key: str = ""
    chat_base_url: str = "https://ws-j9yvjavs76o44pca.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    chat_model: str = "qwen3.7-flash"

    # === 检索与问答 ===
    # === 检索 Top-K: 交给LLM的候选 chunk 数量
    retrieval_top_k: int = 5
    # 拒答阈值: cosine similarity(= 1 - cosine_distance)的下限
    # Top-K 中最高分仍低于此值，直接拒答，不调LLM
    retrieval_min_score: float = 0.6
    # 多轮窗口: load_context 节点取最近多少轮塞进 prompt
    chat_history_window: int = 5

    @model_validator(mode="after")
    def _assemble_database_url(self) -> "Settings":
        """未配置 DATABASE_URL 时，根据 POSTGRES_* 组装异步连接串。"""
        if not self.database_url:
            self.database_url = (
                f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
                f"@localhost:{self.postgres_port}/{self.postgres_db}"
            )
        return self

    @property
    def cos_configured(self) -> bool:
        return bool(self.cos_secret_id and self.cos_secret_key and self.cos_bucket)

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """返回进程内唯一的配置实例；测试时可用 ``get_settings.cache_clear()`` 重建。"""
    return Settings()


settings = get_settings()
