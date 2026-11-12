from app.core.config import settings
from app.llm.query_rewriter import get_query_rewriter
from app.workflows.rag_state import RAGState


async def route_query(state: RAGState) -> RAGState:
    if not settings.query_routing_enabled:
        return {"route": "original", "query": state["question"]}

    result = await get_query_rewriter().optimize(
        question=state['query'],
        multi_query_count=settings.multi_query_count,
    )
    update: RAGState = {
        "route": result.route,
        "query": result.query,
    }
    if result.rewritten_query is not None:
        update["rewritten_query"] = result.rewritten_query
    if result.hyde_answer is not None:
        update["hyde_answer"] = result.hyde_answer
    if result.multi_queries is not None:
        update["multi_queries"] = result.multi_queries
    return update
