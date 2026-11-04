"""文档主操作与分块查询接口；业务规则、事务与入库调度由 Service 管理。"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, File, Query, Response, UploadFile
from fastapi.responses import PlainTextResponse, RedirectResponse

from app.api.deps import DbSession
from app.api.schemas.documents import (
    ChunkDetailResponse,
    ChunkListItemResponse,
    ChunkListResponse,
    ChunkStatsResponse,
    DocumentListResponse,
    DocumentResponse,
    DocumentStatusResponse,
)
from app.db.models import DocumentStatus
from app.services.document_service import DocumentService

router = APIRouter(prefix="/documents", tags=["文档"])


def get_document_service(session: DbSession) -> DocumentService:
    """每个请求复用依赖注入的数据库会话。"""
    return DocumentService(session)


DocumentServiceDep = Annotated[DocumentService, Depends(get_document_service)]


@router.post(
    "",
    response_model=DocumentResponse,
    status_code=202,
    operation_id="uploadDocument",
    summary="上传文档",
)
async def upload_document(
    service: DocumentServiceDep,
    background_tasks: BackgroundTasks,
    file: Annotated[UploadFile, File(description="PDF、DOCX、Markdown、TXT 或 HTML 文件")],
) -> DocumentResponse:
    document = await service.upload(file, background_tasks)
    return DocumentResponse.model_validate(document)


@router.get(
    "",
    response_model=DocumentListResponse,
    operation_id="listDocuments",
    summary="分页查询文档",
)
async def list_documents(
    service: DocumentServiceDep,
    status: Annotated[DocumentStatus | None, Query(description="文档处理状态")] = None,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> DocumentListResponse:
    documents = await service.list_documents(status=status, offset=offset, limit=limit)
    total = await service.count_documents(status=status)
    return DocumentListResponse(
        items=[DocumentResponse.model_validate(document) for document in documents],
        total=total,
        offset=offset,
        limit=limit,
    )


@router.get(
    "/{document_id}",
    response_model=DocumentResponse,
    operation_id="getDocument",
    summary="查询文档详情",
)
async def get_document(document_id: UUID, service: DocumentServiceDep) -> DocumentResponse:
    return DocumentResponse.model_validate(await service.get_document(document_id))


@router.get(
    "/{document_id}/status",
    response_model=DocumentStatusResponse,
    operation_id="getDocumentStatus",
    summary="查询文档处理状态",
)
async def get_document_status(
    document_id: UUID,
    service: DocumentServiceDep,
) -> DocumentStatusResponse:
    return DocumentStatusResponse.model_validate(await service.get_document(document_id))


@router.get(
    "/{document_id}/preview",
    response_class=Response,
    operation_id="getDocumentPreview",
    summary="内联预览 PDF 或隔离渲染 HTML",
    responses={200: {"content": {"application/pdf": {}, "text/html": {}}}},
)
async def get_document_preview(
    document_id: UUID,
    service: DocumentServiceDep,
) -> Response:
    content, mime_type = await service.get_preview_content(document_id)
    headers = {
        "Content-Disposition": "inline",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }
    if mime_type == "text/html":
        headers["Content-Security-Policy"] = (
            "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; "
            "style-src 'unsafe-inline'; img-src data:; font-src data:; "
            "connect-src 'none'; form-action 'none'; base-uri 'none'"
        )
    return Response(content, media_type=mime_type, headers=headers)


@router.get(
    "/{document_id}/content",
    response_class=PlainTextResponse,
    operation_id="getDocumentContent",
    summary="读取 TXT 或 Markdown 原文",
)
async def get_document_content(
    document_id: UUID,
    service: DocumentServiceDep,
) -> PlainTextResponse:
    content = await service.get_text_content(document_id)
    return PlainTextResponse(
        content,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get(
    "/{document_id}/file",
    status_code=307,
    response_class=RedirectResponse,
    operation_id="getDocumentFile",
    summary="下载或预览文档原文件",
    responses={
        307: {
            "description": "跳转到有效期为 300 秒的 COS 文件地址",
            "headers": {"Location": {"schema": {"type": "string", "format": "uri"}}},
        },
    },
)
async def get_document_file(
    document_id: UUID,
    service: DocumentServiceDep,
    disposition: Annotated[int, Query(ge=0, le=1, description="0 尝试内联预览，1 强制下载")] = 0,
) -> RedirectResponse:
    url = await service.get_file_url(document_id, disposition=disposition)
    return RedirectResponse(url, status_code=307, headers={"Cache-Control": "no-store"})


@router.delete(
    "/{document_id}",
    status_code=204,
    operation_id="deleteDocument",
    summary="删除文档",
)
async def delete_document(document_id: UUID, service: DocumentServiceDep) -> Response:
    await service.delete_document(document_id)
    return Response(status_code=204)


@router.post(
    "/{document_id}/retry",
    response_model=DocumentResponse,
    status_code=202,
    operation_id="retryDocument",
    summary="重试失败文档",
)
async def retry_document(
    document_id: UUID,
    service: DocumentServiceDep,
    background_tasks: BackgroundTasks,
) -> DocumentResponse:
    return DocumentResponse.model_validate(await service.retry(document_id, background_tasks))


@router.get(
    "/{document_id}/chunks",
    response_model=ChunkListResponse,
    operation_id="listDocumentChunks",
    summary="分页查询文档分块",
)
async def list_document_chunks(
    document_id: UUID,
    service: DocumentServiceDep,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> ChunkListResponse:
    chunks = await service.list_chunks(document_id, offset=offset, limit=limit)
    total = await service.count_chunks(document_id)
    return ChunkListResponse(
        items=[ChunkListItemResponse.model_validate(chunk) for chunk in chunks],
        total=total,
        offset=offset,
        limit=limit,
    )


@router.get(
    "/{document_id}/chunks/stats",
    response_model=ChunkStatsResponse,
    operation_id="getDocumentChunkStats",
    summary="查询文档分块统计",
)
async def get_document_chunk_stats(
    document_id: UUID,
    service: DocumentServiceDep,
) -> ChunkStatsResponse:
    return ChunkStatsResponse.model_validate(await service.get_chunk_stats(document_id))


@router.get(
    "/{document_id}/chunks/{chunk_id}",
    response_model=ChunkDetailResponse,
    operation_id="getDocumentChunk",
    summary="查询文档分块详情",
)
async def get_document_chunk(
    document_id: UUID,
    chunk_id: UUID,
    service: DocumentServiceDep,
) -> ChunkDetailResponse:
    return ChunkDetailResponse.model_validate(await service.get_chunk(document_id, chunk_id))
