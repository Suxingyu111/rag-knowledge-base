import json
from dataclasses import dataclass

from app.core.logging import get_logger

from app.retrieval.vector_retriever import RetrievedChunk
from app.llm.models import get_chat_model
from app.llm.prompts import build_verify_answer_messages, format_context

logger = get_logger(__name__)


@dataclass(frozen=True)
class VerifyResult:
    """
    answer_verifier 单次校验结果。

    verified=True 时 reason 可能是空字符串（不需要解释为什么通过）。
    """

    verified: bool
    reason: str


class AnswerVerifier:
    """LLM 答案可信度校验器。"""

    async def verify(
        self,
        question: str,
        answer: str,
        chunks: list[RetrievedChunk],
    ) -> VerifyResult:
        if not chunks or not answer.strip():
            return VerifyResult(verified=False, reason="缺少可校验的答案或参考片段")

        try:
            messages = build_verify_answer_messages(
                question=question,
                answer=answer,
                chunks_text=format_context(chunks),
            )
            response = await get_chat_model().ainvoke(messages)
            raw = _extract_text(response.content).strip()
            return _parse_result(raw)
        except Exception:
            logger.exception(
                "answer verifier 调用失败，按校验未通过处理；question=%r", question
            )
            return VerifyResult(verified=False, reason="答案校验暂时不可用")


def _parse_result(raw: str) -> VerifyResult:
    """解析 LLM JSON 输出。无法解析或缺少布尔结论时，按校验未通过处理。"""
    text = raw.strip()
    # 容错：模型偶尔会把 JSON 包住 ```json...``` 里
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("answer verifier JSON 解析失败，按校验未通过处理：raw=%r", raw)
        return VerifyResult(verified=False, reason="无法解析答案校验结果")

    if not isinstance(data, dict):
        return VerifyResult(verified=False, reason="无法解析答案校验结果")

    verified_raw = data.get("verified")
    # 严格只认布尔值；字符串 "true" / 1 等都视为非法，避免歧义
    if not isinstance(verified_raw, bool):
        logger.warning(
            "answer verifier 返回 verified 字段非布尔，按校验未通过处理：raw=%r", raw
        )
        return VerifyResult(verified=False, reason="答案校验结果缺少有效结论")
    
    reason = str(data.get("reason") or "").strip()
    return VerifyResult(verified=verified_raw, reason=reason)

def _extract_text(content: str | list[str | dict]) -> str:
    """兼容 langchain ChatModel 的 content 联合类型。"""
    if isinstance(content, str):
        return content
    return "".join(part.get("text", "") for part in content if isinstance(part, dict))


_verifier: AnswerVerifier | None = None

def get_answer_verifier() -> AnswerVerifier:
    global _verifier
    if _verifier is None:
        _verifier = AnswerVerifier()
    return _verifier