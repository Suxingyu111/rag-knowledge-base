"""腾讯云 COS 客户端封装。

``cos-python-sdk-v5`` 只提供同步接口，本模块以 :class:`CosS3Client` 为底层实现，
通过 :func:`asyncio.to_thread` 把阻塞的网络调用放入线程池，向上层
（FastAPI 异步接口、异步任务）暴露统一的 ``async`` API。

设计要点：

- **懒加载**：只有真正发起请求时才创建 ``CosS3Client``，避免应用启动阶段因
  未配置 COS 而失败；配置缺失时抛出 :class:`ConfigurationError`。
- **错误归一**：把 SDK 的 ``CosServiceError`` / ``CosClientError`` 转换成项目
  自定义异常，API 层可通过全局异常处理器返回一致的错误响应。
- **不吞异常**：``object_exists`` 只把 404 视为“对象不存在”，其余错误继续抛出。

典型用法::

    from app.storage.cos_client import cos_client

    key = await cos_client.upload_bytes(
        "documents/2024/report.pdf",
        data,
        content_type="application/pdf",
    )
    url = await cos_client.get_presigned_url(key, expires_in=3600)
"""

from __future__ import annotations

import asyncio
import mimetypes
import threading
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path
from typing import Any, BinaryIO, TypeVar

from qcloud_cos import CosConfig, CosS3Client
from qcloud_cos.cos_exception import CosClientError, CosServiceError

from app.core.config import settings
from app.core.exceptions import (
    AppException,
    BadRequestError,
    ConfigurationError,
    NotFoundError,
)
from app.core.logging import get_logger

logger = get_logger(__name__)

_T = TypeVar("_T")

# COS 批量删除接口单次最多支持 1000 个对象
_DELETE_BATCH_SIZE = 1000


class COSError(AppException):
    """COS 操作失败（网络异常、鉴权失败、服务端错误等）。"""

    code = "cos_error"
    message = "对象存储服务异常"
    http_status = HTTPStatus.BAD_GATEWAY


class COSObjectNotFoundError(NotFoundError):
    """指定的对象在 COS 中不存在。"""

    code = "cos_object_not_found"
    message = "对象存储中的文件不存在"


@dataclass(frozen=True, slots=True)
class COSObjectInfo:
    """COS 对象元信息。"""

    key: str
    size: int
    etag: str | None = None
    content_type: str | None = None
    last_modified: str | None = None
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class COSObjectPage:
    """``list_objects`` 的分页结果。"""

    items: list[COSObjectInfo]
    is_truncated: bool = False
    next_marker: str | None = None


class COSClient:
    """腾讯云 COS 异步客户端。

    实例本身无状态，可被多个协程并发复用；底层同步客户端内部使用连接池，
    首次访问 :attr:`sync_client` 时创建。
    """

    def __init__(
        self,
        *,
        secret_id: str | None = None,
        secret_key: str | None = None,
        region: str | None = None,
        bucket: str | None = None,
        timeout: int = 60,
        pool_connections: int = 10,
        pool_max_size: int = 10,
    ) -> None:
        """创建客户端。

        参数默认取自 :data:`app.core.config.settings`；显式传参主要用于测试或
        多存储桶场景。注意不要在每次请求时新建实例，复用模块级 ``cos_client``。
        """
        self._secret_id = settings.cos_secret_id if secret_id is None else secret_id
        self._secret_key = settings.cos_secret_key if secret_key is None else secret_key
        self._region = settings.cos_region if region is None else region
        self._bucket = settings.cos_bucket if bucket is None else bucket
        self._timeout = timeout
        self._pool_connections = pool_connections
        self._pool_max_size = pool_max_size

        self._client: CosS3Client | None = None
        self._client_lock = threading.Lock()

    # ------------------------------------------------------------------
    # 基础属性
    # ------------------------------------------------------------------
    @property
    def is_configured(self) -> bool:
        """是否已具备发起请求所需的最小配置。"""
        return bool(self._secret_id and self._secret_key and self._bucket)

    @property
    def bucket(self) -> str:
        self._ensure_configured()
        return self._bucket

    @property
    def region(self) -> str:
        return settings.cos_region

    @property
    def sync_client(self) -> CosS3Client:
        """底层同步客户端。

        仅建议在封装未覆盖的 SDK 高级能力时使用；常规操作请调用本类的
        ``async`` 方法，避免在事件循环中直接执行阻塞 IO。
        """
        client = self._client
        if client is not None:
            return client

        with self._client_lock:
            if self._client is None:
                self._ensure_configured()
                config = CosConfig(
                    Region=self._region,
                    SecretId=self._secret_id,
                    SecretKey=self._secret_key,
                    Scheme="https",
                    Timeout=self._timeout,
                    PoolConnections=self._pool_connections,
                    PoolMaxSize=self._pool_max_size,
                )
                self._client = CosS3Client(config)
                logger.info(
                    "COS 客户端初始化完成: region=%s bucket=%s",
                    self._region,
                    self._bucket,
                )
            return self._client

    def _ensure_configured(self) -> None:
        if self.is_configured:
            return

        missing = [
            name
            for name, value in (
                ("COS_SECRET_ID", self._secret_id),
                ("COS_SECRET_KEY", self._secret_key),
                ("COS_BUCKET", self._bucket),
            )
            if not value
        ]
        raise ConfigurationError(
            "COS 配置缺失，请检查 .env 中的 COS_* 变量",
            details={"missing": missing},
        )

    # ------------------------------------------------------------------
    # 上传
    # ------------------------------------------------------------------
    async def put_object(
        self,
        key: str,
        data: bytes | bytearray | memoryview | BinaryIO,
        *,
        content_type: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> str:
        """上传内存数据或可读文件对象，返回规范化后的对象 key。

        - ``data`` 为 ``bytes`` / ``bytearray`` / ``memoryview`` 时整块上传；
        - ``data`` 为文件对象时由 SDK 流式读取。

        注意 ``put_object`` 单次最大 5GB，更大文件请使用 :meth:`upload_file`。
        ``metadata`` 会以 ``x-cos-meta-*`` 形式写入对象元信息。
        """
        object_key = self._normalize_key(key)
        body: Any = (
            bytes(data) if isinstance(data, (bytearray, memoryview)) else data
        )

        extra: dict[str, Any] = {}
        if content_type:
            extra["ContentType"] = content_type
        if metadata:
            extra["Metadata"] = metadata

        await self._run(
            self.sync_client.put_object,
            Bucket=self.bucket,
            Key=object_key,
            Body=body,
            **extra,
        )
        logger.info("COS 上传成功: key=%s", object_key)
        return object_key

    async def upload_file(
        self,
        key: str,
        local_path: str | Path,
        *,
        content_type: str | None = None,
        metadata: dict[str, str] | None = None,
        part_size: int = 10,
        max_thread: int = 5,
    ) -> str:
        """上传本地文件，返回规范化后的对象 key。

        文件超过 ``part_size`` 时 SDK 会自动走分块并发上传。

        :param part_size: 分块大小，单位 MB，不能小于 1。
        :param max_thread: 分块并发线程数，不能小于 1。
        """
        object_key = self._normalize_key(key)
        path = Path(local_path)
        if not path.is_file():
            raise NotFoundError(
                f"待上传的本地文件不存在: {path}",
                details={"path": str(path)},
            )
        if part_size < 1:
            raise BadRequestError("part_size 不能小于 1（单位 MB）")
        if max_thread < 1:
            raise BadRequestError("max_thread 不能小于 1")

        if content_type is None:
            content_type = mimetypes.guess_type(path.name)[0]

        extra: dict[str, Any] = {}
        if content_type:
            extra["ContentType"] = content_type
        if metadata:
            extra["Metadata"] = metadata

        await self._run(
            self.sync_client.upload_file,
            Bucket=self.bucket,
            Key=object_key,
            LocalFilePath=str(path),
            PartSize=part_size,
            MAXThread=max_thread,
            **extra,
        )
        logger.info("COS 上传成功: key=%s path=%s", object_key, path)
        return object_key

    # ------------------------------------------------------------------
    # 下载
    # ------------------------------------------------------------------
    async def get_object(self, key: str) -> bytes:
        """下载对象内容到内存。大文件建议使用 :meth:`download_file`。"""
        object_key = self._normalize_key(key)
        response = await self._run(
            self.sync_client.get_object,
            Bucket=self.bucket,
            Key=object_key,
        )

        body = response.get("Body")
        if body is None:
            raise COSError(
                "COS 响应缺少 Body",
                details={"key": object_key},
            )

        try:
            data = await asyncio.to_thread(body.get_raw_stream().read)
        except Exception as exc:  # 读取阶段可能抛出 urllib3 / IO 异常
            raise COSError(
                "读取 COS 对象内容失败",
                details={"key": object_key, "error": str(exc)},
            ) from exc

        logger.info("COS 下载成功: key=%s size=%d", object_key, len(data))
        return data

    async def download_file(
        self,
        key: str,
        local_path: str | Path,
        *,
        part_size: int = 20,
        max_thread: int = 5,
    ) -> Path:
        """下载对象到本地文件，返回目标路径；父目录不存在时自动创建。"""
        object_key = self._normalize_key(key)
        if part_size < 1:
            raise BadRequestError("part_size 不能小于 1（单位 MB）")
        if max_thread < 1:
            raise BadRequestError("max_thread 不能小于 1")

        destination = Path(local_path)
        destination.parent.mkdir(parents=True, exist_ok=True)

        await self._run(
            self.sync_client.download_file,
            Bucket=self.bucket,
            Key=object_key,
            DestFilePath=str(destination),
            PartSize=part_size,
            MAXThread=max_thread,
        )
        logger.info("COS 下载成功: key=%s path=%s", object_key, destination)
        return destination

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------
    async def object_exists(self, key: str) -> bool:
        """判断对象是否存在。

        仅将 404（``NoSuchKey``）视为不存在，鉴权失败、网络错误等仍会抛出。
        """
        object_key = self._normalize_key(key)
        try:
            await self._run(
                self.sync_client.head_object,
                Bucket=self.bucket,
                Key=object_key,
            )
        except COSObjectNotFoundError:
            return False
        return True

    async def head_object(self, key: str) -> COSObjectInfo:
        """获取对象元信息（大小、ETag、Content-Type、自定义元数据等）。"""
        object_key = self._normalize_key(key)
        headers = await self._run(
            self.sync_client.head_object,
            Bucket=self.bucket,
            Key=object_key,
        )
        return self._parse_headers(object_key, headers)

    async def list_objects(
        self,
        prefix: str = "",
        *,
        max_keys: int = 1000,
        marker: str | None = None,
    ) -> COSObjectPage:
        """按前缀分页列出对象。

        :param max_keys: 单页数量，取值 1~1000。
        :param marker: 上一页返回的 ``next_marker``，用于继续翻页。
        """
        if not 1 <= max_keys <= _DELETE_BATCH_SIZE:
            raise BadRequestError("max_keys 必须在 1~1000 之间")

        def _list() -> dict[str, Any]:
            kwargs: dict[str, Any] = {
                "Bucket": self.bucket,
                "Prefix": prefix,
                "MaxKeys": max_keys,
            }
            if marker:
                kwargs["Marker"] = marker
            return self.sync_client.list_objects(**kwargs)

        response = await self._run(_list)
        raw_items = response.get("Contents") or []
        if isinstance(raw_items, Mapping):
            raw_items = [raw_items]

        items = [self._parse_list_item(item) for item in raw_items]
        is_truncated = response.get("IsTruncated", False)
        if isinstance(is_truncated, str):
            is_truncated = is_truncated.lower() == "true"

        return COSObjectPage(
            items=items,
            is_truncated=bool(is_truncated),
            next_marker=response.get("NextMarker") or None,
        )

    async def get_presigned_url(
        self,
        key: str,
        *,
        expires_in: int = 3600,
        method: str = "GET",
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> str:
        """生成带签名的临时访问 URL。

        :param expires_in: 有效期（秒），必须大于 0。
        :param method: HTTP 方法，常用 ``GET``（下载）/ ``PUT``（直传）。
        :param params: 附加到签名中的查询参数，例如
            ``{"response-content-type": "application/pdf"}``。
        :param headers: 附加到签名中的请求头。
        """
        object_key = self._normalize_key(key)
        if expires_in <= 0:
            raise BadRequestError("expires_in 必须大于 0")

        url = await self._run(
            self.sync_client.get_presigned_url,
            Bucket=self.bucket,
            Key=object_key,
            Method=method.upper(),
            Expired=expires_in,
            Params=params or {},
            Headers=headers or {},
        )
        return str(url)

    # ------------------------------------------------------------------
    # 删除
    # ------------------------------------------------------------------
    async def delete_object(self, key: str) -> None:
        """删除单个对象；对象不存在时 COS 同样返回成功。"""
        object_key = self._normalize_key(key)
        await self._run(
            self.sync_client.delete_object,
            Bucket=self.bucket,
            Key=object_key,
        )
        logger.info("COS 删除成功: key=%s", object_key)

    async def delete_objects(self, keys: Iterable[str]) -> int:
        """批量删除对象，返回提交删除的对象数量。

        COS 单次最多删除 1000 个对象，本方法会自动分批。
        """
        object_keys = [self._normalize_key(key) for key in keys]
        if not object_keys:
            return 0

        for start in range(0, len(object_keys), _DELETE_BATCH_SIZE):
            batch = object_keys[start : start + _DELETE_BATCH_SIZE]
            await self._run(
                self.sync_client.delete_objects,
                Bucket=self.bucket,
                Delete={
                    "Object": [{"Key": key} for key in batch],
                    "Quiet": True,
                },
            )

        logger.info("COS 批量删除成功: count=%d", len(object_keys))
        return len(object_keys)

    # ------------------------------------------------------------------
    # 内部工具
    # ------------------------------------------------------------------
    async def _run(
        self,
        func: Callable[..., _T],
        /,
        *args: Any,
        **kwargs: Any,
    ) -> _T:
        """在线程池中执行同步 SDK 调用，并把 SDK 异常转换为项目异常。"""
        try:
            return await asyncio.to_thread(func, *args, **kwargs)
        except (CosServiceError, CosClientError) as exc:
            raise _translate_cos_error(exc, kwargs.get("Key")) from exc

    @staticmethod
    def _normalize_key(key: str) -> str:
        """去掉首尾空白和开头的 ``/``，并拒绝空 key。"""
        normalized = key.strip().lstrip("/")
        if not normalized:
            raise BadRequestError(
                "COS 对象 key 不能为空",
                details={"key": key},
            )
        return normalized

    @staticmethod
    def _parse_headers(key: str, headers: Mapping[str, Any]) -> COSObjectInfo:
        lowered = {str(name).lower(): value for name, value in headers.items()}

        raw_size = lowered.get("content-length")
        try:
            size = int(raw_size) if raw_size is not None else 0
        except (TypeError, ValueError):
            size = 0

        etag_value = lowered.get("etag")
        etag = str(etag_value).strip('"') if etag_value is not None else None
        content_type_value = lowered.get("content-type")
        last_modified_value = lowered.get("last-modified")

        metadata = {
            name[len("x-cos-meta-") :]: str(value)
            for name, value in lowered.items()
            if name.startswith("x-cos-meta-")
        }

        return COSObjectInfo(
            key=key,
            size=size,
            etag=etag,
            content_type=(
                str(content_type_value) if content_type_value is not None else None
            ),
            last_modified=(
                str(last_modified_value) if last_modified_value is not None else None
            ),
            metadata=metadata,
        )

    @staticmethod
    def _parse_list_item(item: Mapping[str, Any]) -> COSObjectInfo:
        raw_size = item.get("Size")
        try:
            size = int(raw_size) if raw_size is not None else 0
        except (TypeError, ValueError):
            size = 0

        etag_value = item.get("ETag")
        etag = str(etag_value).strip('"') if etag_value is not None else None
        last_modified_value = item.get("LastModified")

        return COSObjectInfo(
            key=str(item.get("Key", "")),
            size=size,
            etag=etag,
            last_modified=(
                str(last_modified_value) if last_modified_value is not None else None
            ),
        )


def _translate_cos_error(
    exc: CosServiceError | CosClientError,
    key: Any,
) -> AppException:
    """把 SDK 异常转换为项目自定义异常，并保留 COS 错误码与 RequestId。"""
    if isinstance(exc, CosClientError):
        return COSError(
            "COS 客户端请求失败",
            details={"key": key, "error": str(exc)},
        )

    details = {
        "key": key,
        "cos_code": _safe_call(exc.get_error_code, "Unknown"),
        "status_code": _safe_call(exc.get_status_code, None),
        "request_id": _safe_call(exc.get_request_id, None),
        "resource": _safe_call(exc.get_resource_location, None),
    }

    if details["status_code"] == 404 or details["cos_code"] in {
        "NoSuchKey",
        "NoSuchResource",
    }:
        return COSObjectNotFoundError(details=details)

    return COSError(
        f"COS 服务返回错误: {_safe_call(exc.get_error_msg, 'Unknown')}",
        details=details,
    )


def _safe_call(getter: Callable[[], _T], default: _T) -> _T:
    """调用 SDK 的错误信息 getter；字段缺失时返回默认值，避免二次异常。"""
    try:
        return getter()
    except (KeyError, TypeError, AttributeError):
        return default


# 模块级单例：连接池随进程复用，不要在请求处理函数中重复创建
cos_client = COSClient()


def get_cos_client() -> COSClient:
    """FastAPI 依赖注入入口，返回全局 COS 客户端。"""
    return cos_client
