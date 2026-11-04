import type { DocumentStatus } from '../client/types.gen'

/** 颜色使用 Ant Design Tag 的预设色，可直接传给 color 属性。 */
export type DocumentStatusInfo = Readonly<{
  text: string
  color: string
}>

/** 与接口状态类型保持一致；新增状态时由 TypeScript 检查映射是否完整。 */
export const DOCUMENT_STATUS_MAP = {
  uploading: { text: '上传中', color: 'blue' },
  parsing: { text: '解析中', color: 'cyan' },
  splitting: { text: '切分中', color: 'geekblue' },
  embedding: { text: '向量化中', color: 'purple' },
  indexing: { text: '索引中', color: 'orange' },
  ready: { text: '已就绪', color: 'success' },
  failed: { text: '处理失败', color: 'error' },
} as const satisfies Record<DocumentStatus, DocumentStatusInfo>

const UNKNOWN_STATUS: DocumentStatusInfo = {
  text: '未知状态',
  color: 'default',
}

/** 同时获取文案与颜色，例如：<Tag color={info.color}>{info.text}</Tag>。 */
export function getDocumentStatusInfo(
  status: string | null | undefined,
): DocumentStatusInfo {
  if (status && Object.hasOwn(DOCUMENT_STATUS_MAP, status)) {
    return DOCUMENT_STATUS_MAP[status as DocumentStatus]
  }
  return UNKNOWN_STATUS
}

export function getDocumentStatusText(status: string | null | undefined): string {
  return getDocumentStatusInfo(status).text
}

export function getDocumentStatusColor(status: string | null | undefined): string {
  return getDocumentStatusInfo(status).color
}

/** 就绪或失败表示本次处理已结束，可停止轮询文档状态。 */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return status === 'ready' || status === 'failed'
}
