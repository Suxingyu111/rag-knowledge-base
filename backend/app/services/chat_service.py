from sqlalchemy.ext.asyncio import AsyncSession
from app.retrieval.vector_retriever import RetrievedChunk
from app.core.logging import get_logger
from app.core.config import settings

from langsmith import traceable
from app.core.observability import build_trace_url, get_current_trace_id

from uuid import UUID
from app.core.exceptions import NotFoundError
from app.db.models import Conversation, Message, AnswerCitation
from app.db.repositories.conversation_repo import ConversationRepository

from collections.abc import AsyncIterator
from app.db.repositories.citation_repo import AnswerCitationRepository
from app.db.session import AsyncSessionLocal
from app.workflows.graph import get_rag_graph
from app.workflows.nodes import load_context, stream_generate
from app.workflows.rag_state import RAGState

from app.llm.answer_verifier import VerifyResult, get_answer_verifier
from app.llm.prompts import REFUSAL_ANSWER

logger = get_logger(__name__)

def _serialize_citation(chunk: RetrievedChunk, ordinal: int) -> dict:
    """
    citations SSE 事件载荷格式，与 CitationRead 对齐

    ordinal 必须显式传入：与 prompt 中给 LLM 看到的「片段N」编号一致，
    前端按这个数字渲染[N]角标，避免后续顺序丢失导致引用串号。
    """
    return {
        "ordinal": ordinal,
        "chunk_id": str(chunk.chunk_id),
        "document_id": str(chunk.document_id),
        "document_name": chunk.document_name,
        "page_no": chunk.page_no,
        "section_path": chunk.section_path,
        "score": round(chunk.score, 4),
        "quote": chunk.content,
        "retrieval_meta": _build_retrieval_meta(chunk)
    }

def _build_query_route_payload(state: RAGState) -> dict:
    """
    route_query SSE 事件载荷格式（与前端约定一致）
    """
    return {
        "route": state.get("route", "original"),
        "query": state.get("query", ""),
        "rewritten_query": state.get("rewritten_query"),
        "multi_queries": state.get("multi_queries", []),
        "hyde_answer": state.get("hyde_answer"),
    }

def _build_retrieval_meta(chunk: RetrievedChunk) -> dict:
    """混合检索调试元数据"""
    return {
        "sources": list(chunk.sources),
        "vector_rank": chunk.vector_rank,
        "vector_score": (
            round(chunk.vector_score, 4) if chunk.vector_score is not None else None
        ),
        "keyword_rank": chunk.keyword_rank,
        "keyword_score": (
            round(chunk.keyword_score, 4) if chunk.keyword_score is not None else None
        ),
        "rrf_score": (
            round(chunk.rrf_score, 6) if chunk.rrf_score is not None else None
        ),
        "rerank_score": (
            round(chunk.rerank_score, 4) if chunk.rerank_score is not None else None
        ),
    }

def _build_verify_payload(
    result: VerifyResult, *, replacement_answer: str | None
) -> dict:
    """verify_result SSE / metadata 共用载荷。

    replacement_answer 仅在 verified=False 时携带；前端直接展示该拒答文案，
    与 PRD "verify 失败 -> 拒答替换"语义对齐。
    """
    payload: dict = {
        "verified": result.verified,
        "reason": result.reason or None,
    }
    if not result.verified and replacement_answer is not None:
        payload["replacement_answer"] = replacement_answer
    return payload


class ChatService:
    """
    注意：
    
    - 非流式接口（创建会话 / 历史）使用 FastAPI 注入的请求级 session
    - 流式问答使用独立 session（与请求生命周期解耦），由 stream_answer 内部管理
    """
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create_conversation(self, title: str = "新对话") -> Conversation:
        repo = ConversationRepository(self.session)
        conversation = await repo.create(title=title)
        await self.session.commit()
        await self.session.refresh(conversation)
        return conversation

    async def get_conversation(self, conversation_id: UUID) -> Conversation:
        repo = ConversationRepository(self.session)
        conversation = await repo.get(conversation_id)
        if conversation is None:
            raise NotFoundError("会话不存在")
        return conversation

    async def list_messages(
            self, conversation_id: UUID
    ) -> tuple[Conversation, list[Message]]:
        # 先校验会话存在，避免"空会话"和"会话不存在"被混淆
        conversation = await self.get_conversation(conversation_id)
        repo = ConversationRepository(self.session)
        messages = await repo.list_messages(conversation_id)
        return conversation, messages
    
    @traceable(name="ChatService.stream_answer", run_type="chain")
    async def stream_answer(
            self, conversation_id: UUID, question: str
    ) -> AsyncIterator[dict]:
        """逐事件 yield SSE 载荷。

        事件协议（与前端约定）：
            message_start → query_route → agent_steps → [context_check]
            → [verify_start → verify_result] → citations → [token...] → message_saving → message_end
        校验失败时仅通过 verify_result.replacement_answer 发送拒答正文。
        任何阶段出错则改 yield error 并提前结束。
        """

        # 校验会话存在用 service 自动 session；流式跑独立 session
        await self.get_conversation(conversation_id)

        async with AsyncSessionLocal() as session:
            try:
                # 取 LangSmith trace_id: @traceable 已经为本次 stream_answer 建好 root run，
                # 这里读到的就是整次回答的 trace_id；未观测时返回 None
                trace_id = get_current_trace_id()
                state: RAGState = {
                    "conversation_id": conversation_id,
                    "question": question,
                    "trace_id": trace_id,
                }
                # 1.加载上下文（仅历史消息，本轮 user 此刻尚未入库）
                # load_context 是唯一需要 DB session 的节点，由 service 先填好再交给图。
                state.update(await load_context(state, session))

                # 2.跑 RAG 子图：normalize_query -> route_query -> 检索决策循环
                final_state = await get_rag_graph().ainvoke(state)
                state.update(final_state) # type: ignore[arg-type]

                # 3. user 消息落库
                await self._persist_user_message(state, session)

                yield {
                    "event": "message_start",
                    "data": {
                        "user_message_id": str(state["user_message_id"]),
                        "trace_id": trace_id,
                        "trace_url": build_trace_url(trace_id),
                    },
                }

                # 4.把 query 路由结果推给前端调试面板（始终发送，前端按 route 选择渲染）
                yield {
                    "event": "query_route",
                    "data": _build_query_route_payload(state),
                }
                yield {
                    "event": "agent_steps",
                    "data": {"steps": _serialize_agent_steps(state)},
                }

                if "context_is_enough" in state:
                    yield {
                        "event": "context_check",
                        "data": {"sufficient": state["context_is_enough"]},
                    }

                verify_result: VerifyResult | None = None
                if settings.verify_answer_enabled and not state.get("refused"):
                    # 收集完整答案供校验，校验通过前不发布正文和引用。
                    state["answer"] = "".join([delta async for delta in stream_generate(state)])
                    yield {"event": "verify_start", "data": {}}
                    verify_result = await get_answer_verifier().verify(
                        question=state["query"],
                        answer=state["answer"],
                        chunks=list(state.get("retrieved_chunks", [])),
                    )
                    replacement = None
                    if not verify_result.verified:
                        replacement = REFUSAL_ANSWER
                        state["answer"] = replacement
                        state["refused"] = True
                    yield {
                        "event": "verify_result",
                        "data": _build_verify_payload(
                            verify_result, replacement_answer=replacement
                        ),
                    }

                # 拒答路径下不下发 citation，retrieved_chunks 可能还残留 agent 循环
                # 中途某一轮的候选（被 observe_context 判为不足），但语义上既然已经拒答，
                # 前端就不该再展示这些参考资料
                citations_payload = (
                    []
                    if state.get("refused")
                    else [
                        _serialize_citation(c, ordinal=i)
                        for i, c in enumerate(
                            state.get("retrieved_chunks", []), start=1
                        )
                    ]
                )
                yield {
                    "event": "citations",
                    "data": {"citations": citations_payload},
                }

                if verify_result is not None:
                    if verify_result.verified:
                        yield {"event": "token", "data": {"delta": state["answer"]}}
                elif state.get("refused"):
                    yield {"event": "token", "data": {"delta": state["answer"]}}
                else:
                    answer_parts: list[str] = []
                    async for delta in stream_generate(state):
                        answer_parts.append(delta)
                        yield {"event": "token", "data": {"delta": delta}}
                    state["answer"] = "".join(answer_parts)

                yield {"event": "message_saving", "data": {}}
                await self._persist_assistant_message(state, session, verify_result=verify_result)

                yield {
                    "event": "message_end",
                    "data": {
                        "message_id": str(state["assistant_message_id"]),
                        "refused": bool(state.get("refused"))
                    },
                }

            except Exception as exc:
                logger.exception("chat stream failed: conversation_id=%s", conversation_id)
                # 注意：user 消息可能已在前面独立 commit，这里只回滚为提交的部分
                # （比如： assistant 写入中途失败）。保留 user 消息便于前端排查 / 重试。
                await session.rollback()
                yield {
                    "event": "error",
                    "data": {
                        "code": "chat_stream_failed",
                        "message": str(exc).strip() or "问答处理失败"
                    }
                }

    async def list_conversations(
        self, page: int, page_size: int
    ) -> tuple[list[tuple[Conversation, int]], int]:
        repo = ConversationRepository(self.session)
        return await repo.list_page(page=page, page_size=page_size)

    async def delete_conversation(self, conversation_id: UUID) -> None:
        repo = ConversationRepository(self.session)
        deleted = await repo.delete(conversation_id)
        if not deleted:
            raise NotFoundError("会话不存在")
        await self.session.commit()

    async def _persist_user_message(
            self, state: RAGState, session: AsyncSession
    ) -> None:
        """
        流式开始前先把 user 消息落库并 commit；首次提问时顺手把会话标题改成问题前 30 字。

        必须在 load_context 之后调用：load_context 读到的"历史消息"不应包含本轮提问。
        标题更新放在同一事务里，避免新建会话后侧栏一直显示「新对话」。
        """
        repo = ConversationRepository(session)
        # 首次提问（会话还没有任何消息）-> 把默认标题改成本次问题
        message_count = await repo.count_messages(state["conversation_id"])
        if message_count == 0:
            await repo.update_title_if_default(
                state["conversation_id"], state["question"]
            )
        user_msg = ConversationRepository.make_user_message(
            state["conversation_id"], content=state["question"]
        )
        await repo.add_messages([user_msg])
        await session.commit()
        state["user_message_id"] = user_msg.id

    async def _persist_assistant_message(
            self,
            state: RAGState,
            session: AsyncSession,
            *,
            verify_result: VerifyResult | None
    ) -> None:
        """流式生成结束后落库 assistant 消息及其引用，单事务保证两者原子。"""
        conv_repo = ConversationRepository(session)
        citation_repo = AnswerCitationRepository(session)

        extra_metada: dict = {
            "refused": bool(state.get("refused")),
            "query_route": _build_query_route_payload(state),
            "agent_steps": _serialize_agent_steps(state),
            # LangSmith trace_id 落库，刷新历史时前端仍可展示 / 跳转
            "trace_id": state.get("trace_id"),
        }
        if verify_result is not None:
            # verify_result 复用 SSE 载荷格式，但 metadata 不需要 replacement_answer
            extra_metada["verify_result"] = _build_verify_payload(
                verify_result, replacement_answer=None
            )

        assistant_msg = ConversationRepository.make_assistant_message(
            state["conversation_id"],
            content=state["answer"],
            extra_metadata=extra_metada,
        )
        await conv_repo.add_messages([assistant_msg])

        if not state.get("refused"):
            citations = [
                AnswerCitation(
                    message_id=assistant_msg.id,
                    ordinal=ordinal,
                    document_id=chunk.document_id,
                    chunk_id=chunk.chunk_id,
                    document_name=chunk.document_name,
                    page_no=chunk.page_no,
                    quote=chunk.content,
                    retrieval_meta=_build_retrieval_meta(chunk),
                )
                for ordinal, chunk in enumerate(
                    state.get("retrieved_chunks", []), start=1
                )
            ]
            await citation_repo.bulk_add(citations)

        await session.commit()
        state["assistant_message_id"] = assistant_msg.id

def _serialize_agent_steps(state: RAGState) -> list[dict]:
    """
    SSE / metadata 共用的 agent_steps 载荷格式。

    state 内字段全部用原生 Python 类型，直接 JSON 序列化即可；这里做一层显示拷贝
    避免后续节点继续追加时影响已经发出的事件 / 已持久化的 metadata。
    """
    return [dict(step) for step in state.get("agent_steps", [])]

            
                

