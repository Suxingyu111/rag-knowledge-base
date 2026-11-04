"""下载、解析、切分、向量化和分块入库的异步流水线。"""

import asyncio
from uuid import UUID

from app.core.config import settings
from app.core.exceptions import NotFoundError
from app.core.logging import get_logger
from app.db.models import Document, DocumentChunk, DocumentStatus
from app.db.repositories.chunk_repo import ChunkRepository
from app.db.repositories.document_repo import DocumentRepository
from app.db.session import AsyncSessionLocal
from app.ingestion import embedder, parser, splitter
from app.storage.file_service import get_file_service

logger = get_logger(__name__)


async def update_status(
    document_id: UUID,
    status: DocumentStatus,
    *,
    error_message: str | None = None,
) -> Document:
    """用独立会话和事务提交状态，让其他请求可以轮询已提交进度。"""
    async with AsyncSessionLocal() as session:
        async with session.begin():
            document = await DocumentRepository(session).update_status(
                document_id, status, error_message=error_message
            )
            if document is None:
                raise NotFoundError("文档不存在")
        return document


async def ingest_document(document_id: UUID) -> None:
    """处理已提交到数据库且已上传 COS 的文档。

    调用方应先提交文档记录，再调度本函数；同一文档不得并发入库。
    每个阶段独立提交状态，耗时处理不持有数据库事务。
    失败时记录 FAILED 并继续抛出原始异常，供任务调用方处理。
    """
    document = await update_status(document_id, DocumentStatus.UPLOADING)
    try:
        content = await get_file_service().download(document.cos_object_key)

        await update_status(document_id, DocumentStatus.PARSING)
        documents = await parser.parse(document.name, content)

        await update_status(document_id, DocumentStatus.SPLITTING)
        chunks = await asyncio.to_thread(splitter.split_documents, documents)
        if not chunks:
            raise ValueError("文档切分结果为空")

        await update_status(document_id, DocumentStatus.EMBEDDING)
        vectors = await embedder.get_embeddings().aembed_documents(
            [chunk.page_content for chunk in chunks]
        )
        if len(vectors) != len(chunks):
            raise ValueError("向量数量与文档分块数量不一致")
        if any(len(vector) != settings.embedding_dim for vector in vectors):
            raise ValueError("向量维度与配置不一致")

        await update_status(document_id, DocumentStatus.INDEXING)
        records = [
            DocumentChunk(
                document_id=document_id,
                content=chunk.page_content,
                embedding=vector,
                chunk_index=index,
                page_no=chunk.metadata.get("page_no"),
                section_path=chunk.metadata.get("section_path"),
                extra_metadata=dict(chunk.metadata),
            )
            for index, (chunk, vector) in enumerate(zip(chunks, vectors, strict=True))
        ]
        async with AsyncSessionLocal() as session:
            async with session.begin():
                repository = ChunkRepository(session)
                await repository.delete_chunks(document_id)
                await repository.add_chunks(records)

        await update_status(document_id, DocumentStatus.READY)
    except Exception as exc:
        logger.exception("文档入库失败: document_id=%s", document_id)
        try:
            await update_status(
                document_id, DocumentStatus.FAILED, error_message=str(exc)
            )
        except Exception:
            logger.exception("记录文档失败状态失败: document_id=%s", document_id)
        raise
