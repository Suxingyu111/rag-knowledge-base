from urllib.parse import quote

from qcloud_cos.cos_exception import CosClientError, CosServiceError

from app.core.logging import get_logger
from app.storage.cos_client import COSClient, get_cos_client

logger = get_logger(__name__)

class FileService:
    def __init__(self, cos: COSClient | None = None) -> None:
        self._cos = cos or get_cos_client()

    @property
    def bucket(self) -> str:
        return self._cos.bucket

    @property
    def region(self) -> str:
        return self._cos.region

    @staticmethod
    def build_object_key(file_hash: str, suffix: str) -> str:
        return f"documents/{file_hash}{suffix}"

    async def upload(self, *, content: bytes, file_hash: str, suffix: str, mime_type: str) -> str:
        key = self.build_object_key(file_hash, suffix)
        await self._cos.put_object(key=key, data=content, content_type=mime_type)
        return key

    async def download(self, object_key: str) -> bytes:
        return await self._cos.get_object(object_key)

    async def get_file_url(
        self,
        object_key: str,
        *,
        filename: str,
        mime_type: str,
        disposition: str,
    ) -> str:
        """签发五分钟 GET 地址，覆盖原文件的展示方式及 MIME。"""
        content_disposition = (
            f'{disposition}; filename="document"; '
            f"filename*=UTF-8''{quote(filename, safe='')}"
        )
        return await self._cos.get_presigned_url(
            object_key,
            method="GET",
            expires_in=300,
            params={
                "response-content-type": mime_type,
                "response-content-disposition": content_disposition,
            },
        )

    async def delete(self, object_key: str) -> None:
        try:
            await self._cos.delete_object(object_key)
        except (CosClientError, CosServiceError) as exc:
            logger.warning(f"cos delete failed: key={object_key}, err={exc}")


def get_file_service() -> FileService:
    return FileService()
