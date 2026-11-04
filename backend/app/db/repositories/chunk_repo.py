"""文档分块的数据访问；事务由调用方 Service 管理。"""

from collections.abc import Sequence
from typing import TypedDict
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import DocumentChunk


class ChunkStats(TypedDict):
    """文档分块总数及正文字符长度统计，空集合的长度统计为 None。"""

    count: int
    avg: float | None
    min: int | None
    max: int | None


class ChunkRepository:
    """复用外部会话，仅执行查询和 flush，不提交、回滚或关闭会话。

    数据库异常原样交给 Service；文档归属、内容与向量校验由 Service 负责。
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, chunk: DocumentChunk) -> DocumentChunk:
        """新增单个分块并 flush，返回原实例。"""
        self._session.add(chunk)
        await self._session.flush()
        return chunk

    async def get_by_id(self, chunk_id: UUID) -> DocumentChunk | None:
        """按主键返回分块，不存在返回 None，不隐式加载 document。"""
        return await self._session.get(DocumentChunk, chunk_id)

    async def get_by_document_and_chunk_id(
        self, document_id: UUID, chunk_id: UUID
    ) -> DocumentChunk | None:
        """同时匹配文档和分块 ID；不存在或分块不属于该文档时返回 None。"""
        return await self._session.scalar(
            select(DocumentChunk).where(
                DocumentChunk.document_id == document_id,
                DocumentChunk.id == chunk_id,
            )
        )

    async def get_by_ids(self, chunk_ids: Sequence[UUID]) -> list[DocumentChunk]:
        """批量查询已有分块，按 ID 升序返回；忽略缺失和重复 ID。

        不保证输入顺序，Service 如需按检索结果排序，应按 ID 重新映射。
        """
        if not chunk_ids:
            return []
        statement = (
            select(DocumentChunk)
            .where(DocumentChunk.id.in_(chunk_ids))
            .order_by(DocumentChunk.id.asc())
        )
        return list((await self._session.scalars(statement)).all())

    async def add_chunks(self, chunks: Sequence[DocumentChunk]) -> list[DocumentChunk]:
        """批量写入分块；字段沿用模型定义，包括 embedding、extra_metadata。"""
        items = list(chunks)
        if items:
            self._session.add_all(items)
            await self._session.flush()
        return items

    async def get_chunks(self, document_id: UUID) -> list[DocumentChunk]:
        """按文档查询分块，以 chunk_index、id 升序稳定排列。"""
        statement = (
            select(DocumentChunk)
            .where(DocumentChunk.document_id == document_id)
            .order_by(DocumentChunk.chunk_index.asc(), DocumentChunk.id.asc())
        )
        return list((await self._session.scalars(statement)).all())

    async def list_chunks(
        self,
        document_id: UUID,
        *,
        offset: int = 0,
        limit: int = 20,
    ) -> list[DocumentChunk]:
        """按文档分页查询，以 chunk_index、id 升序稳定排列。"""
        if offset < 0 or limit <= 0:
            raise ValueError("offset 必须非负，limit 必须为正整数")
        statement = (
            select(DocumentChunk)
            .where(DocumentChunk.document_id == document_id)
            .order_by(DocumentChunk.chunk_index.asc(), DocumentChunk.id.asc())
            .offset(offset)
            .limit(limit)
        )
        return list((await self._session.scalars(statement)).all())

    async def count_chunks(self, document_id: UUID) -> int:
        """统计指定文档的分块数，无分块或文档不存在时返回 0。"""
        statement = (
            select(func.count())
            .select_from(DocumentChunk)
            .where(DocumentChunk.document_id == document_id)
        )
        return await self._session.scalar(statement)

    async def get_chunk_stats(self, document_id: UUID) -> ChunkStats:
        """一条 SQL 返回分块总数及 content 字符长度的 avg/min/max。

        空正文长度为 0；无分块时 count 为 0，其余为 None。
        不读取正文到 Python，不主动 flush，不区分文档不存在与无分块。
        """
        length = func.length(DocumentChunk.content)
        statement = select(
            func.count().label("count"),
            func.avg(length).label("avg"),
            func.min(length).label("min"),
            func.max(length).label("max"),
        ).where(DocumentChunk.document_id == document_id)
        count, avg, minimum, maximum = (await self._session.execute(statement)).one()
        return {
            "count": count,
            "avg": float(avg) if avg is not None else None,
            "min": minimum,
            "max": maximum,
        }

    async def delete(self, chunk_id: UUID) -> bool:
        """按主键物理删除单个分块，不存在返回 False。"""
        chunk = await self.get_by_id(chunk_id)
        if chunk is None:
            return False
        await self._session.delete(chunk)
        await self._session.flush()
        return True

    async def delete_chunks(self, document_id: UUID) -> int:
        """删除指定文档的全部分块，返回删除数，供 Service 组合重建事务。"""
        # 会话关闭了 autoflush，先写出待新增分块，使后续 DELETE 能覆盖它们。
        await self._session.flush()
        result = await self._session.execute(
            delete(DocumentChunk).where(DocumentChunk.document_id == document_id)
        )
        return result.rowcount
