import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from app.llm.answer_verifier import AnswerVerifier, _parse_result
from app.services import chat_service as chat


class ChatVerificationTests(unittest.IsolatedAsyncioTestCase):
    async def test_stream_releases_only_the_verified_answer(self):
        for enabled, refused, verified in (
            (True, False, True),
            (True, False, False),
            (False, False, False),
            (True, True, False),
        ):
            with self.subTest(enabled=enabled, refused=refused, verified=verified):
                session = AsyncMock()
                service = chat.ChatService(session)
                service.get_conversation = AsyncMock()
                service._persist_user_message = AsyncMock(
                    side_effect=lambda state, _: state.update(user_message_id=uuid4()),
                )
                service._persist_assistant_message = AsyncMock(
                    side_effect=lambda state, _, **kwargs: state.update(assistant_message_id=uuid4()),
                )
                graph = AsyncMock()
                graph.ainvoke.return_value = {
                    "query": "问题", "refused": refused, "answer": chat.REFUSAL_ANSWER,
                }
                verifier = AsyncMock()
                verifier.verify.return_value = chat.VerifyResult(verified=verified, reason="")

                @asynccontextmanager
                async def open_session():
                    yield session

                async def generate(state):
                    yield "候选"
                    yield "答案"

                with (
                    patch.object(chat.settings, "verify_answer_enabled", enabled),
                    patch.object(chat, "AsyncSessionLocal", open_session),
                    patch.object(chat, "load_context", AsyncMock(return_value={})),
                    patch.object(chat, "get_rag_graph", return_value=graph),
                    patch.object(chat, "stream_generate", generate),
                    patch.object(chat, "get_answer_verifier", return_value=verifier),
                ):
                    events = [event async for event in service.stream_answer(uuid4(), "问题")]

                names = [event["event"] for event in events]
                tokens = [event["data"]["delta"] for event in events if event["event"] == "token"]
                self.assertEqual(names[-2:], ["message_saving", "message_end"])
                if enabled and not refused:
                    verifier.verify.assert_awaited_once()
                    self.assertEqual(verifier.verify.call_args.kwargs["answer"], "候选答案")
                    self.assertLess(names.index("verify_start"), names.index("verify_result"))
                    self.assertLess(names.index("verify_result"), names.index("citations"))
                    if verified:
                        self.assertLess(names.index("verify_result"), names.index("token"))
                        self.assertEqual("".join(tokens), "候选答案")
                    else:
                        self.assertEqual(tokens, [])
                        result = next(event["data"] for event in events if event["event"] == "verify_result")
                        self.assertEqual(result["replacement_answer"], chat.REFUSAL_ANSWER)
                else:
                    verifier.verify.assert_not_awaited()
                    self.assertNotIn("verify_start", names)
                    self.assertEqual("".join(tokens), chat.REFUSAL_ANSWER if refused else "候选答案")

    async def test_unavailable_verifier_cannot_pass(self):
        verifier = AnswerVerifier()
        result = await verifier.verify("问题", "候选答案", [])
        self.assertFalse(result.verified)

        model = AsyncMock()
        model.ainvoke.side_effect = TimeoutError
        with (
            patch("app.llm.answer_verifier.format_context", return_value="参考片段"),
            patch("app.llm.answer_verifier.get_chat_model", return_value=model),
            self.assertLogs("app.llm.answer_verifier", level="ERROR"),
        ):
            result = await verifier.verify("问题", "候选答案", [object()])

        model.ainvoke.assert_awaited_once()
        self.assertFalse(result.verified)

    def test_invalid_verifier_output_cannot_pass(self):
        for output in ("无法解析", "[]", '{"verified": "true"}'):
            with self.subTest(output=output):
                self.assertFalse(_parse_result(output).verified)
