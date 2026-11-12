from app.llm.prompts import REFUSAL_ANSWER
from app.workflows.rag_state import RAGState

async def refuse(stata: RAGState) -> RAGState:
    return {"refused": True, "answer": REFUSAL_ANSWER}
