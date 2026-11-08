import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Empty, Spin } from 'antd'
import MarkdownComponents from '@/components/MarkdownComponents'

import { api } from '@/api/client'
import type { DocumentResponse } from '@/client/types.gen'
import { getDocumentDownloadUrl, getDocumentPreviewUrl, isMarkdownDocument } from '@/utils/documentFile'

/** 文本、PDF 与 HTML 均通过后端读取，HTML 使用不具备同源权限的沙箱。 */
export default function DocumentPreview({ document }: { document: DocumentResponse }) {
  const mime = document.mime_type.split(';', 1)[0].trim().toLowerCase()
  const markdown = isMarkdownDocument(document)
  const text = useQuery({
    queryKey: ['document-preview', document.id],
    queryFn: ({ signal }) => api.documents.readText(document.id, { signal, silent: true }),
    enabled: markdown || mime === 'text/plain',
    retry: false,
  })

  if (markdown || mime === 'text/plain') {
    return (
      <Spin spinning={text.isLoading}>
        {text.isError ? (
          <Alert type="error" showIcon title="原文读取失败"
            description={text.error.message}
            action={<Button onClick={() => { void text.refetch() }}>重试</Button>} />
        ) : text.isSuccess ? (
          <div style={{ maxHeight: 600, overflow: 'auto', overflowWrap: 'anywhere' }}>
            {markdown ? <MarkdownComponents>{text.data}</MarkdownComponents>
              : <pre style={{ whiteSpace: 'pre-wrap' }}>{text.data}</pre>}
          </div>
        ) : <p>正在读取原文…</p>}
      </Spin>
    )
  }
  if (['application/pdf', 'text/html', 'application/xhtml+xml'].includes(mime)) {
    return (
      <>
        <iframe title={`${document.name} 原文预览`} src={getDocumentPreviewUrl(document.id)}
          sandbox={mime === 'application/pdf' ? undefined : 'allow-scripts'}
          referrerPolicy="no-referrer" style={{ width: '100%', height: 600, border: 0 }} />
      </>
    )
  }
  return (
    <Empty description={mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ? 'DOCX 暂不支持在线预览，请下载后查看' : '此文件类型暂不支持在线预览'}>
      <Button href={getDocumentDownloadUrl(document.id)} type="primary">下载原文件</Button>
    </Empty>
  )
}
