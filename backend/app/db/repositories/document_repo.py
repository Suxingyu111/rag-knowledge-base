"""文档的数据访问；事务由调用方 Service 管理。"""

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Document, DocumentStatus


class DocumentRepository:
    """复用 Service 注入的会话，不提交、回滚或关闭会话。

    写操作显式 flush，便于取得默认字段并及时暴露数据库约束错误。
    数据库异常原样交给 Service，由其决定整个事务的回滚与错误转换。
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, document: Document) -> Document:
        """写入 Service 构造的文档，返回带数据库默认值的实例。"""
        self._session.add(document)
        await self._session.flush()
        return document

    async def get_by_id(self, document_id: UUID) -> Document | None:
        """按主键查询，不隐式加载 chunks。"""
        return await self._session.get(Document, document_id)

    async def get_by_hash(self, file_hash: str) -> Document | None:
        """按文件哈希查询；并发去重仍由数据库唯一约束保证。"""
        return await self._session.scalar(
            select(Document).where(Document.file_hash == file_hash)
        )

    async def list_documents(
        self,
        *,
        status: DocumentStatus | None = None,
        offset: int = 0,
        limit: int = 20,
    ) -> list[Document]:
        """按创建时间倒序分页，可按状态过滤。"""
        if offset < 0 or limit <= 0:
            raise ValueError("offset 必须非负，limit 必须为正整数")
        statement = select(Document)
        if status is not None:
            statement = statement.where(Document.status == status)
        statement = statement.order_by(
            Document.created_at.desc(), Document.id.desc()
        ).offset(offset).limit(limit)
        return list((await self._session.scalars(statement)).all())

    async def count_documents(self, *, status: DocumentStatus | None = None) -> int:
        """统计相同状态筛选条件下的总数，不应用分页。"""
        statement = select(func.count()).select_from(Document)
        if status is not None:
            statement = statement.where(Document.status == status)
        return await self._session.scalar(statement)

    async def update_status(
        self,
        document_id: UUID,
        status: DocumentStatus,
        *,
        error_message: str | None = None,
    ) -> Document | None:
        """更新状态和错误信息；省略错误信息时清空旧值，不校验业务状态流转。"""
        document = await self.get_by_id(document_id)
        if document is None:
            return None
        document.status = status
        document.error_message = error_message
        await self._session.flush()
        return document

    async def delete(self, document_id: UUID) -> bool:
        """物理删除文档，关联分块按模型级联删除；不操作 COS。"""
        document = await self.get_by_id(document_id)
        if document is None:
            return False
        await self._session.delete(document)
        await self._session.flush()
        return True
