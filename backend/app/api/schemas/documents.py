"""面向用户的文档与分块响应模型。"""

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.db.models import DocumentStatus

CHUNK_SUMMARY_MAX_LENGTH = 200


class DocumentResponse(BaseModel):
    """文档元信息，不暴露 COS 配置、文件哈希或关联分块。"""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    mime_type: str
    size: int = Field(ge=0, description="文件字节数")
    status: DocumentStatus
    error_message: str | None
    created_at: datetime
    updated_at: datetime


class DocumentListResponse(BaseModel):
    """文档分页；total 为同一筛选条件下的总数。"""

    items: list[DocumentResponse]
    total: int = Field(ge=0)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=20, gt=0)


class DocumentStatusResponse(BaseModel):
    """供轮询使用的文档处理状态。"""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    status: DocumentStatus
    error_message: str | None
    updated_at: datetime


class ChunkResponse(BaseModel):
    """分块公共定位信息。"""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    document_id: UUID
    chunk_index: int = Field(ge=0)
    page_no: int | None
    section_path: str | None
    created_at: datetime


class ChunkListItemResponse(ChunkResponse):
    """列表只返回正文截断摘要，不包含完整正文和任意元数据。"""

    summary: str = Field(
        validation_alias="content",
        max_length=CHUNK_SUMMARY_MAX_LENGTH,
        description="正文前 200 个字符；截断时末尾省略号包含在长度限制内",
    )

    @field_validator("summary", mode="before")
    @classmethod
    def truncate_summary(cls, value: Any) -> Any:
        if isinstance(value, str) and len(value) > CHUNK_SUMMARY_MAX_LENGTH:
            return value[: CHUNK_SUMMARY_MAX_LENGTH - 1] + "…"
        return value


class ChunkListResponse(BaseModel):
    """指定文档的分块分页结果。"""

    items: list[ChunkListItemResponse]
    total: int = Field(ge=0)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=20, gt=0)


class ChunkDetailResponse(ChunkResponse):
    """完整正文与解析元数据，不返回向量。"""

    content: str
    extra_metadata: dict[str, Any] = Field(default_factory=dict)


class ChunkStatsResponse(BaseModel):
    """对应 Repository 的字符长度统计；无分块时长度统计为 null。"""

    count: int = Field(ge=0)
    avg: float | None = Field(ge=0)
    min: int | None = Field(ge=0)
    max: int | None = Field(ge=0)
