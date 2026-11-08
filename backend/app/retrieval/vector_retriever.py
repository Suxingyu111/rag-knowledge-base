from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.repositories.chunk_repo import ChunkRepository
from app.ingestion.embedder import get_embeddings


@dataclass(frozen=True)
class RetrievedChunk:
    chunk_id: UUID
    document_id: UUID
    document_name: str
    content: str
    page_no: int | None
    section_path: str | None
    score: float
    sources: tuple[str, ...] = field(default_factory=tuple)
    vector_rank: int | None = None
    vector_score: float | None = None
    keyword_rank: int | None = None
    keyword_score: float | None = None
    rrf_score: float | None = None


class VectorRetriever:
    def __init__(self, session: AsyncSession) -> None:
        self.chunk_repo = ChunkRepository(session)

    async def search(self, query: str, top_k: int) -> list[RetrievedChunk]:
        embedding = await get_embeddings().aembed_query(query)
        rows = await self.chunk_repo.vector_search(embedding, top_k)
        return [
            RetrievedChunk(
                chunk_id=chunk.id,
                document_id=chunk.document_id,
                document_name=chunk.document.name,
                content=chunk.content,
                page_no=chunk.page_no,
                section_path=chunk.section_path,
                # pgvector cosine_distance E [0, 2]; 标准化为 similarity E [-1, 1]
                # pgvector cosine_distance E [0, 2]; 标准化为 similarity
                # 同方向归一化向量下,distance E [0, 1],similarity E [0,1]
                score=1.0 - distance,
                sources=("vector", ),
                vector_rank=rank,
                vector_score=1.0 - distance,
            )
            for rank, (chunk, distance) in enumerate(rows, start=1)
        ]
        