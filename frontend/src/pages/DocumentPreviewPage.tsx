import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Card } from 'antd'
import { useParams } from 'react-router-dom'

import { api } from '@/api/client'
import type { DocumentResponse } from '@/client/types.gen'
import DocumentPreview from '@/components/DocumentPreview'

/** 独立预览窗口，不携带工作台布局，也不跳转至 COS 下载地址。 */
export default function DocumentPreviewPage() {
  const { documentId } = useParams<'documentId'>()
  const documentQuery = useQuery({
    queryKey: ['documents', 'detail', documentId],
    queryFn: ({ signal }) => api.get<DocumentResponse>(
      `/documents/${encodeURIComponent(documentId!)}`, { signal, silent: true },
    ),
    enabled: Boolean(documentId),
  })

  return (
    <main style={{ maxWidth: 1200, margin: '24px auto', padding: '0 16px' }}>
      <Card title={documentQuery.data?.name ?? '原文预览'} loading={documentQuery.isLoading}>
        {documentQuery.isError && (
          <Alert type="error" showIcon title="文档信息加载失败" description={documentQuery.error.message}
            action={<Button onClick={() => { void documentQuery.refetch() }}>重试</Button>} />
        )}
        {!documentId && <Alert type="error" title="缺少文档 ID" />}
        {documentQuery.data && <DocumentPreview document={documentQuery.data} />}
      </Card>
    </main>
  )
}
