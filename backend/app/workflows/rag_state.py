from typing import TypedDict, Literal
from uuid import UUID

from app.db.models import Message
from app.retrieval.vector_retriever import RetrievedChunk

QueryRoute = Literal["original", "rewrite", "hyde", "multi_query"]


class RAGState(TypedDict, total=False):
    # 输入
    conversation_id: UUID
    question: str

    # load_context 产出
    chat_history: list[Message]

    # route_query 产出
    # rewrite 和 hyde 使用生成的检索文本，其余策略保留原问题。
    query: str
    route: QueryRoute
    rewritten_query: str | None
    hyde_answer: str | None
    multi_queries: list[str] | None

    # retrieve 产出
    retrieved_chunks: list[RetrievedChunk]
    # 是否触发拒答（检索不足）。True 时跳过 generate
    refused: bool

    # generate 产出
    answer: str

    # chat_service 落库后回写
    user_message_id: UUID
    assistant_message_id: UUID