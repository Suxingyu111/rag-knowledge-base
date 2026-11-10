from dataclasses import dataclass
from typing import get_args

from app.core.logging import get_logger
from app.llm.models import get_chat_model
from app.llm.prompts import (
    build_route_messages,
    build_rewrite_messages,
    build_hyde_messages,
    build_multi_query_messages,
)
from app.workflows.rag_state import QueryRoute

logger = get_logger(__name__)

_VALID_ROUTES: tuple[str, ...] = get_args(QueryRoute)


@dataclass(frozen=True)
class QueryRouterResult:
    """
    Query 优化的统一返回结构。

    - route: 最终采用的策略
    - query: 要喂给向量检索的查询文本(rewrite/hyde 路径下是改写后的文本, 其余是原问题)
    - 余下三个字段按 route 选择性填充，便于前端调试展示和落库
    """
    route: QueryRoute
    query: str
    rewritten_query: str | None = None
    hyde_answer: str | None = None
    multi_queries: list[str] | None = None


def _extract_text(content: str | list[str | dict]) -> str:
    """兼容 LangChain ChatModel 的 context 联合类型"""
    if isinstance(content, str):
        return content
    return "\n".join(part["text"] for part in content if isinstance(part, dict))


class QueryRewriter:
    """
    4 步 Query 优化的协同入口。所有 LLM 调用都走单例 ChatOpenAI.
    """
    async def decide_route(self, question: str) -> QueryRoute:
        """
        1. route_query: 决策采用哪条策略
        """
        messages = build_route_messages(question)
        response = await get_chat_model().ainvoke(messages)
        raw = _extract_text(response.content).strip().lower()
        token = raw.strip("\"'`.。 ")
        if token in _VALID_ROUTES:
            return token
        logger.warning(f"query route 模型返回非法值，降级 original: raw=%r",raw)
        return "original"

    async def rewrite(self, question: str) -> str:
        """
        2. query_rewrite: 改写问题
        """
        messages = build_rewrite_messages(question)
        response = await get_chat_model().ainvoke(messages)
        return _extract_text(response.content).strip()

    async def hyde(self, question: str) -> str:
        """
        3. query_hyde: 生成假设答案
        """
        messages = build_hyde_messages(question)
        response = await get_chat_model().ainvoke(messages)
        return _extract_text(response.content).strip()

    async def multi_query(self, question: str, n: int) -> list[str]:
        """
        4. query_multi: 拆分子查询
        """
        messages = build_multi_query_messages(question, n)
        response = await get_chat_model().ainvoke(messages)
        text = _extract_text(response.content)
        queries = [line.strip(" \"'`。-·*1233456789.、") for line in text.splitlines()]
        return [q for q in queries if q][:n]  # 取前 n 条

    async def apply_route(
            self, question: str, route: QueryRoute, multi_query_count: int
    ) -> QueryRouterResult:
        """
        已知目标 route 时，按 route 执行对应改写链路并填充 QueryRouteResult.

        与 optimize 的区别：optimeze 内部先调 decide_route 判断 route，再调本方法分发；
        apply_route 跳过判断环节，直接按调用方给定的 route 执行 Agentic RAG
        在 switch_route 决策时由 planner 直接指定 route，复用这套分发逻辑补齐字段，
        避免在 plan_retrieval 节点里再写一遍 if-elif 与降级兜底。
        """
        try:
            if route == "rewrite":
                rewritten = await self.rewrite(question)
                if not rewritten:
                    return QueryRouterResult(route="original", query=question)
                return QueryRouterResult(route="rewrite", query=rewritten, rewritten_query=rewritten)
            if route == "hyde":
                hyde_answer = await self.hyde(question)
                if not hyde_answer:
                    return QueryRouterResult(route="original", query=question)
                return QueryRouterResult(route="hyde", query=hyde_answer, hyde_answer=hyde_answer)
            if route == "multi_query":
                multi_queries = await self.multi_query(question, multi_query_count)
                if not multi_queries:
                    return QueryRouterResult(route="original", query=question)
                return QueryRouterResult(route="multi_query", query=question, multi_queries=multi_queries)
            return QueryRouterResult(route="original", query=question)
        except Exception:
            logger.exception("apply_route 失败，降级 original: route=%s question=%r", route, question)
            return QueryRouterResult(route="original", query=question)

    async def optimize(self, question: str, multi_query_count: int) -> QueryRouterResult:
        """
        按 route 分发并填充结果。任何一步失败都安全降级到 original。
        """
        try:
            route = await self.decide_route(question)
        except Exception:
            logger.exception("query route 判定失败，降级 original: question=%r", question)
            return QueryRouterResult(route="original", query=question)
        return await self.apply_route(question, route, multi_query_count)

_rewriter: QueryRewriter | None = None


def get_query_rewriter() -> QueryRewriter:
    global _rewriter
    if _rewriter is None:
        _rewriter = QueryRewriter()
    return _rewriter
