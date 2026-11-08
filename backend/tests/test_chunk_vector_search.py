import unittest
from unittest.mock import AsyncMock, Mock

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.repositories.chunk_repo import ChunkRepository


class ChunkVectorSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_reads_rows_after_awaiting_execute(self):
        session = AsyncMock(spec=AsyncSession)
        chunk = object()
        result = Mock()
        result.all.return_value = [(chunk, 0.25)]
        session.execute.return_value = result

        rows = await ChunkRepository(session).vector_search([0.1, 0.2], top_k=3)

        self.assertEqual(rows, [(chunk, 0.25)])
        session.execute.assert_awaited_once()
        result.all.assert_called_once_with()
