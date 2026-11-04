"""文本切分。

使用 LangChain 的 :class:`~langchain_text_splitters.RecursiveCharacterTextSplitter`，
按分隔符优先级递归地把长文本切成语义相对完整的块：

    Markdown 标题 → 代码块 → 段落 → 行 → 中英文句末 → 分句 → 空白 → 字符

``chunk_size`` / ``chunk_overlap`` 统一从项目根目录的 ``.env`` 读取
（``CHUNK_SIZE`` / ``CHUNK_OVERLAP``），由 :mod:`app.core.config` 负责加载与默认值。
"""

from functools import lru_cache
from http import HTTPStatus

from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.core.config import settings
from app.core.exceptions import AppException
from app.core.logging import get_logger

logger = get_logger(__name__)


class SplitterConfigError(AppException):
    """切分参数不合法，通常是 .env 中的 CHUNK_SIZE / CHUNK_OVERLAP 配置有误。"""

    code = "splitter_config_error"
    message = "文本切分配置不合法"
    http_status = HTTPStatus.INTERNAL_SERVER_ERROR


# 分隔符按优先级从高到低排列：靠前的结构越完整，优先用于切分。
# RecursiveCharacterTextSplitter 会先用第一个能匹配到的分隔符切分，
# 对仍然超长的片段再递归使用后面的分隔符，直到满足 chunk_size。
SEPARATORS: list[str] = [
    # 1. Markdown 标题：优先按章节切分，标题与正文不被拆散
    "\n# ",
    "\n## ",
    "\n### ",
    "\n#### ",
    "\n##### ",
    "\n###### ",
    # 2. 代码块边界：尽量保持代码块完整
    "\n```",
    # 3. 段落
    "\n\n",
    # 4. 换行
    "\n",
    # 5. 中文句末标点
    "。",
    "！",
    "？",
    "；",
    # 6. 英文句末标点
    ". ",
    "! ",
    "? ",
    "; ",
    # 7. 分句
    "，",
    ", ",
    # 8. 空白
    " ",
    # 9. 兜底：按字符硬切
    "",
]


def _validate_params(chunk_size: int, chunk_overlap: int) -> None:
    """校验切分参数，避免 LangChain 在运行时抛出难以定位的错误。"""
    if chunk_size <= 0:
        raise SplitterConfigError(
            f"CHUNK_SIZE 必须为正整数，当前为 {chunk_size}",
            details={"chunk_size": chunk_size},
        )
    if chunk_overlap < 0 or chunk_overlap >= chunk_size:
        raise SplitterConfigError(
            f"CHUNK_OVERLAP 必须满足 0 <= chunk_overlap < chunk_size，"
            f"当前为 {chunk_overlap} / {chunk_size}",
            details={"chunk_size": chunk_size, "chunk_overlap": chunk_overlap},
        )


@lru_cache(maxsize=1)
def get_text_splitter() -> RecursiveCharacterTextSplitter:
    """构造全局唯一的递归切分器，参数取自 .env 中的 CHUNK_SIZE / CHUNK_OVERLAP。

    使用 :func:`functools.lru_cache` 缓存实例，避免重复创建；
    修改 ``.env`` 后重启进程生效（测试中可调用 ``get_text_splitter.cache_clear()``）。
    """
    chunk_size = settings.chunk_size
    chunk_overlap = settings.chunk_overlap
    _validate_params(chunk_size, chunk_overlap)

    logger.info(
        "初始化文本切分器: chunk_size=%s, chunk_overlap=%s", chunk_size, chunk_overlap
    )
    return RecursiveCharacterTextSplitter(
        separators=SEPARATORS,
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        # 保留分隔符并放在下一块开头：Markdown 标题因此能和其正文留在同一块
        keep_separator="start",
        # separators 按普通字符串匹配，不当作正则
        is_separator_regex=False,
        # 用字符数计算长度，对中文更直观（LangChain 默认即 len）
        length_function=len,
    )


def split_text(text: str) -> list[str]:
    """切分纯文本，返回字符串块列表；空白文本返回空列表。"""
    if not text.strip():
        return []
    return get_text_splitter().split_text(text)


def split_documents(documents: list[Document]) -> list[Document]:
    """切分 LangChain ``Document`` 列表。

    保留原文档的 metadata（如 ``source``），并为每个原文档的块补充从 0 开始的
    ``chunk_index``，方便后续写入向量库时定位和去重。
    """
    splitter = get_text_splitter()
    chunks: list[Document] = []

    for document in documents:
        if not document.page_content.strip():
            continue

        document_chunks = splitter.split_documents([document])
        for index, chunk in enumerate(document_chunks):
            chunk.metadata["chunk_index"] = index
        chunks.extend(document_chunks)

    logger.info(
        "文本切分完成: 输入 %s 个文档, 输出 %s 个块", len(documents), len(chunks)
    )
    return chunks
