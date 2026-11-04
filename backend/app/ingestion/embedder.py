"""文档入库使用的嵌入模型客户端。"""

from langchain_core.embeddings import Embeddings
from langchain_openai import OpenAIEmbeddings

from app.core.config import settings
from app.core.exceptions import ConfigurationError


_embeddings: Embeddings | None = None

def get_embeddings() -> Embeddings:
    """根据全局配置创建并返回嵌入模型客户端。"""
    global _embeddings
    if _embeddings is not None:
        return _embeddings

    if not settings.embedding_api_key:
        raise ConfigurationError("Embedding API key 未配置， 请在 .env 设置 EMBEDDING_API_KEY")
    _embeddings = OpenAIEmbeddings(
        model=settings.embedding_model,
        api_key=settings.embedding_api_key,
        base_url=settings.enbeding_base_url,
        dimensions=settings.embedding_dim,
        chunk_size=settings.embedding_batch_size,
        # 兼容接口接收原始文本，由服务端完成分词。
        check_embedding_ctx_length=False,
    )
    return _embeddings
