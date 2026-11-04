"""文档业务服务使用的上传类型校验。"""

import hashlib
from pathlib import Path
from uuid import UUID

from fastapi import BackgroundTasks, UploadFile
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import get_logger

from app.core.exceptions import BadRequestError, ConflictError, NotFoundError
from app.db.models import Document, DocumentChunk, DocumentStatus
from app.db.repositories.document_repo import DocumentRepository
from app.db.repositories.chunk_repo import ChunkRepository, ChunkStats
from app.ingestion.pipeline import ingest_document
from app.storage.file_service import FileService, get_file_service


logger = get_logger(__name__)

MIME_TO_EXTENSIONS: dict[str, set[str]] = {
    "application/pdf": {".pdf"},
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {".docx"},
    "text/markdown": {".md", ".markdown"},
    "text/x-markdown": {".md", ".markdown"},
    "text/plain": {".txt", ".md", ".markdown"},
    "text/html": {".html", ".htm"},
    "application/xhtml+xml": {".html", ".htm"},
}
# 同一后缀可接受多个 MIME；反向映射明确指定存储时的规范 MIME。
EXTENSION_TO_MIME: dict[str, str] = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".html": "text/html",
    ".htm": "text/html",
}


def _resolve_mime_and_suffix(file: UploadFile) -> str:
    """联合校验声明的 MIME 与后缀，返回带点的小写扩展名。

    缺失 MIME 或通用二进制 MIME 时按后缀判断；明确声明的 MIME
    必须与后缀一致。本函数不读取文件内容，不能用于验证真实文件格式。
    """
    extension = Path(file.filename or "").suffix.lower()
    expected_mime = EXTENSION_TO_MIME.get(extension)
    if expected_mime is None:
        raise BadRequestError("不支持的文件扩展名")

    mime_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    if mime_type in ("", "application/octet-stream"):
        return extension
    if mime_type not in MIME_TO_EXTENSIONS:
        raise BadRequestError("不支持的文件 MIME 类型")
    if extension not in MIME_TO_EXTENSIONS[mime_type]:
        raise BadRequestError("文件 MIME 类型与扩展名不匹配")
    return extension


_DELETEABLE_STATUSES = frozenset(
    {DocumentStatus.READY, DocumentStatus.FAILED, DocumentStatus.UPLOADING}
)


class DocumentService:
    """组装文档存储与入库流程；上传成功后自行提交事务。"""

    def __init__(self, session: AsyncSession, file_service: FileService | None = None) -> None:
        self._session = session
        self._document_repo = DocumentRepository(session)
        self._chunk_repo = ChunkRepository(session)
        self._file_service = file_service if file_service is not None else get_file_service()

    async def upload(self, file: UploadFile, background_tasks: BackgroundTasks) -> Document:
        """校验、按内容去重并上传；记录提交成功后才调度独立会话的流水线。"""
        suffix = _resolve_mime_and_suffix(file)
        max_size = settings.upload_max_size_mb * 1024 * 1024
        content = await file.read(max_size + 1)
        if not content:
            raise BadRequestError("不能上传空文件")
        if len(content) > max_size:
            raise BadRequestError(f"文件大小不能超过 {settings.upload_max_size_mb} MB")

        file_hash = hashlib.sha256(content).hexdigest()
        existing = await self._document_repo.get_by_hash(file_hash)
        if existing is not None:
            return existing

        mime_type = EXTENSION_TO_MIME[suffix]
        object_key = await self._file_service.upload(
            content=content, file_hash=file_hash, suffix=suffix, mime_type=mime_type
        )
        document = Document(
            name=file.filename,
            file_hash=file_hash,
            mime_type=mime_type,
            size=len(content),
            storage_provider="cos",
            cos_bucket=self._file_service.bucket,
            cos_object_key=object_key,
            cos_region=self._file_service.region,
            status=DocumentStatus.UPLOADING,
        )
        try:
            await self._document_repo.add(document)
            await self._session.commit()
        except IntegrityError:
            await self._session.rollback()
            existing = await self._document_repo.get_by_hash(file_hash)
            if existing is not None:
                return existing
            raise
        except Exception:
            await self._session.rollback()
            raise

        await self._session.refresh(document)
        background_tasks.add_task(ingest_document, document.id)
        return document


    async def get_document(self, document_id: UUID) -> Document:
        """按 ID 获取文档；不存在时抛出业务异常。"""
        document = await self._document_repo.get_by_id(document_id)
        if document is None:
            raise NotFoundError("文档不存在")
        return document

    async def list_documents(
        self,
        *,
        status: DocumentStatus | None = None,
        offset: int = 0,
        limit: int = 20,
    ) -> list[Document]:
        """按创建时间和 ID 倒序分页，可选按状态筛选。"""
        if offset < 0 or limit <= 0:
            raise BadRequestError("offset 必须非负，limit 必须为正整数")
        return await self._document_repo.list_documents(
            status=status, offset=offset, limit=limit
        )


    async def count_documents(self, *, status: DocumentStatus | None = None) -> int:
        """查询与文档列表相同筛选条件下的总数。"""
        return await self._document_repo.count_documents(status=status)

    async def get_preview_content(self, document_id: UUID) -> tuple[bytes, str]:
        """预览内容由后端返回，避免 COS 强制 attachment 破坏 iframe。"""
        document = await self.get_document(document_id)
        if document.mime_type not in {"application/pdf", "text/html", "application/xhtml+xml"}:
            raise BadRequestError("此接口仅支持 PDF 或 HTML 预览")
        content = await self._file_service.download(document.cos_object_key)
        mime_type = "application/pdf" if document.mime_type == "application/pdf" else "text/html"
        return content, mime_type

    async def get_text_content(self, document_id: UUID) -> str:
        """通过后端读取文本原文，避免浏览器跟随 COS 跳转触发跨域限制。"""
        document = await self.get_document(document_id)
        if document.mime_type not in {"text/plain", "text/markdown", "text/x-markdown"}:
            raise BadRequestError("仅支持读取 TXT 或 Markdown 原文，请下载其他类型文件")
        content = await self._file_service.download(document.cos_object_key)
        try:
            return content.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise BadRequestError("文本文件不是有效 UTF-8 编码，请下载原文件查看") from exc

    async def get_file_url(self, document_id: UUID, *, disposition: int = 0) -> str:
        """访问原文件：0 尝试内联预览，1 强制下载，不限制入库状态。"""
        document = await self.get_document(document_id)
        mime_type = document.mime_type
        if disposition == 0 and mime_type in {
            "text/plain", "text/markdown", "text/x-markdown",
            "text/html", "application/xhtml+xml",
        }:
            mime_type = "text/plain"
        return await self._file_service.get_file_url(
            document.cos_object_key,
            filename=document.name,
            mime_type=mime_type,
            disposition="attachment" if disposition == 1 else "inline",
        )

    async def delete_document(self, document_id: UUID) -> None:
        """先提交数据库删除，再尽力删除 COS；存储失败仅记录告警。"""
        document = await self.get_document(document_id)
        if document.status not in _DELETEABLE_STATUSES:
            raise ConflictError("文档正在处理中，暂不能删除")
        object_key = document.cos_object_key
        try:
            if not await self._document_repo.delete(document_id):
                raise NotFoundError("文档不存在")
            await self._session.commit()
        except Exception:
            await self._session.rollback()
            raise

        try:
            await self._file_service.delete(object_key)
        except Exception as exc:
            logger.warning(
                "COS 文档删除失败: document_id=%s, key=%s, err=%s",
                document_id, object_key, exc,
            )


    async def retry(self, document_id: UUID, background_tasks: BackgroundTasks) -> Document:
        """清理失败文档的残余分块，提交重置状态后重新调度入库。"""
        document = await self.get_document(document_id)
        if document.status != DocumentStatus.FAILED:
            raise ConflictError("仅失败的文档可以重试")

        try:
            await self._chunk_repo.delete_chunks(document_id)
            document = await self._document_repo.update_status(
                document_id, DocumentStatus.UPLOADING, error_message=None
            )
            if document is None:
                raise NotFoundError("文档不存在")
            await self._session.commit()
        except Exception:
            await self._session.rollback()
            raise

        await self._session.refresh(document)
        background_tasks.add_task(ingest_document, document_id)
        return document


    async def get_chunk(self, document_id: UUID, chunk_id: UUID) -> DocumentChunk:
        """获取指定文档的分块，缺失或不属于该文档时返回业务 404。"""
        await self.get_document(document_id)
        chunk = await self._chunk_repo.get_by_document_and_chunk_id(document_id, chunk_id)
        if chunk is None:
            raise NotFoundError("文档分块不存在")
        return chunk

    async def list_chunks(
        self,
        document_id: UUID,
        *,
        offset: int = 0,
        limit: int = 20,
    ) -> list[DocumentChunk]:
        """分页浏览指定文档的分块，按 chunk_index 和 ID 升序返回。"""
        if offset < 0 or limit <= 0:
            raise BadRequestError("offset 必须非负，limit 必须为正整数")
        await self.get_document(document_id)
        return await self._chunk_repo.list_chunks(document_id, offset=offset, limit=limit)

    async def count_chunks(self, document_id: UUID) -> int:
        """统计指定文档的分块总数；文档不存在时返回业务 404。"""
        await self.get_document(document_id)
        return await self._chunk_repo.count_chunks(document_id)

    async def get_chunk_stats(self, document_id: UUID) -> ChunkStats:
        """确认文档存在，再以单条聚合 SQL 查询分块数量与正文字符长度。"""
        await self.get_document(document_id)
        return await self._chunk_repo.get_chunk_stats(document_id)
