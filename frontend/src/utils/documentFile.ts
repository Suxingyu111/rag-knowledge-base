import { API_BASE_URL, resolveApiPath } from '../api/client'

/** 构建原文件接口地址；由后端跳转到临时 COS 地址，不应持久化跳转结果。 */
export function getDocumentFileUrl(
  documentId: string,
  disposition: 0 | 1 = 0,
): string {
  const path = resolveApiPath(`/documents/${encodeURIComponent(documentId)}/file`)
  return `${API_BASE_URL}${path}?disposition=${disposition}`
}

/** 用于 iframe 的 src；是否能显示还取决于 MIME 和浏览器设置。 */
export function getDocumentPreviewUrl(documentId: string): string {
  return `${API_BASE_URL}${resolveApiPath(`/documents/${encodeURIComponent(documentId)}/preview`)}`
}

/** 用于 a 的 href；通过后端 Content-Disposition 强制下载。 */
export function getDocumentDownloadUrl(documentId: string): string {
  return getDocumentFileUrl(documentId, 1)
}

/** 当前文档接口可供浏览器内联显示的 MIME；Markdown、HTML 按纯文本返回。 */
const INLINE_PREVIEW_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/html',
  'application/xhtml+xml',
])

/**
 * 判断是否适合通过原文件接口尝试内联预览，不检测浏览器实际能力。
 * DOCX、未知类型及空值返回 false；PDF 预览仍可能被浏览器设置禁用。
 */
export function canPreviewInline(mimeType: string | null | undefined): boolean {
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  return normalized !== undefined && INLINE_PREVIEW_MIME_TYPES.has(normalized)
}

/** 兼容上传时被标记为纯文本的 Markdown 文件。 */
export function isMarkdownDocument(document: { mime_type: string; name: string }): boolean {
  const mime = document.mime_type.split(';', 1)[0].trim().toLowerCase()
  return mime === 'text/markdown' || mime === 'text/x-markdown'
    || (mime === 'text/plain' && /\.(?:md|markdown)$/i.test(document.name))
}
