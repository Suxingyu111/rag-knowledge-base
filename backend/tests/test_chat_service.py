import unittest
from unittest.mock import AsyncMock
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MessageRole
from app.services.chat_service import ChatService


class ChatServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_persists_question_with_user_role(self):
        session = AsyncMock(spec=AsyncSession)
        state = {"conversation_id": uuid4(), "question": "办公设备管理规范是什么？"}

        await ChatService(session)._persist_user_message(state, session)

        message, = session.add_all.call_args.args[0]
        self.assertEqual(message.role, MessageRole.USER)
        self.assertEqual(message.content, state["question"])
        session.commit.assert_awaited_once()
        session.execute.assert_awaited_once()
        statement = session.execute.call_args.args[0]
        self.assertIn(state["question"], statement.compile().params.values())
        self.assertIn("NOT (EXISTS", str(statement))
