"""文本直接读取，复杂格式在可终止的独立进程内使用 Docling 解析。"""

import asyncio
import io
import json
import os
import sys
from pathlib import Path

from langchain_core.documents import Document

from app.core.config import settings
from app.core.exceptions import AppException
from app.core.logging import get_logger

logger = get_logger(__name__)


class DocumentParseError(AppException):
    code = "document_parse_error"
    message = "文档解析失败"
    http_status = 400


def _convert_sync(filename: str, content: bytes) -> str:
    # 仅在解析子进程导入，避免 Docling 模型初始化锁阻塞其他文档。
    from docling.datamodel.base_models import DocumentStream
    from docling.document_converter import DocumentConverter

    source = DocumentStream(name=filename, stream=io.BytesIO(content))
    result = DocumentConverter().convert(source)
    return result.document.export_to_markdown()


async def parse(filename: str, content: bytes) -> list[Document]:
    """解析原文件；超时或任务取消时真正终止子进程，不留下模型下载线程。"""
    try:
        if Path(filename).suffix.lower() in {".txt", ".md", ".markdown"}:
            markdown = content.decode("utf-8-sig")
        else:
            env = os.environ.copy()
            # Xet 下载在部分网络下可能无限等待；保留标准 HTTPS 下载路径。
            env.setdefault("HF_HUB_DISABLE_XET", "1")
            env.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "15")
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "app.ingestion.parser_worker", filename,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=Path(__file__).resolve().parents[2],
                env=env,
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(content), timeout=settings.document_parse_timeout_seconds
                )
            except (TimeoutError, asyncio.CancelledError):
                if process.returncode is None:
                    process.kill()
                await process.communicate()
                raise
            if process.returncode != 0:
                logger.error("解析子进程失败: filename=%s, stderr=%s", filename, stderr.decode(errors="replace")[-2000:])
                detail = json.loads(stdout).get("error", "解析进程异常退出") if stdout else "解析进程异常退出"
                raise DocumentParseError(f"Docling 解析失败：{detail}")
            markdown = json.loads(stdout)["markdown"]
    except TimeoutError as exc:
        raise DocumentParseError(
            f"解析超过 {settings.document_parse_timeout_seconds:g} 秒已终止，请检查模型下载网络或文件复杂度后重试"
        ) from exc
    except DocumentParseError:
        raise
    except Exception as exc:
        logger.exception("文档解析失败: filename=%s", filename)
        raise DocumentParseError(f"文档解析失败：{exc}") from exc

    if not markdown.strip():
        raise DocumentParseError("解析结果为空，文档可能损坏或不受支持")
    return [Document(page_content=markdown, metadata={"source": filename})]
