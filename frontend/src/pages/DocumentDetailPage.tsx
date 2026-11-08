import { DeleteOutlined, DownloadOutlined, ExportOutlined, ReloadOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Descriptions, Empty, Flex, Modal, Popconfirm, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import { generatePath, Link, useNavigate, useParams } from 'react-router-dom'

import { api } from '@/api/client'
import type { ChunkDetailResponse, ChunkListItemResponse, ChunkListResponse, ChunkStatsResponse, DocumentResponse, DocumentStatus } from '@/client/types.gen'
import StageHead from '@/components/StageHead'
import DocumentPreview from '@/components/DocumentPreview'
import MarkdownComponents from '@/components/MarkdownComponents'
import { canPreviewInline, getDocumentDownloadUrl, isMarkdownDocument } from '@/utils/documentFile'
import { ROUTE_PATHS } from '@/routes/paths'
import { getDocumentStatusInfo, isTerminalStatus } from '@/utils/documentStatus'

const CHUNK_PAGE_SIZE = 20
// 与后端 DocumentService._DELETEABLE_STATUSES 保持一致。
const DELETEABLE_STATUSES: ReadonlySet<DocumentStatus> = new Set(['ready', 'failed', 'uploading'])

export default function DocumentDetailPage() {
  const { documentId } = useParams<'documentId'>()
  if (!documentId) return <Alert type="error" showIcon title="缺少文档 ID" />

  // 切换文档时重建局部状态，避免沿用上一份文档的页码与 chunk 选择。
  return <DocumentDetailContent key={documentId} documentId={documentId} />
}

function DocumentDetailContent({ documentId }: { documentId: string }) {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [chunkPage, setChunkPage] = useState(1)
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null)
  const documentPath = `/documents/${encodeURIComponent(documentId)}`

  const documentQuery = useQuery({
    queryKey: ['documents', 'detail', documentId],
    queryFn: ({ signal }) => api.get<DocumentResponse>(documentPath, { signal, silent: true }),
    // 元数据同时包含处理状态；终态或查询失败后停止轮询。
    refetchInterval: (query) => query.state.status === 'error' || isTerminalStatus(query.state.data?.status)
      ? false : 2_000,
    staleTime: 0,
  })
  const document = documentQuery.data
  const isReady = documentQuery.isSuccess && document?.status === 'ready'
  const canDelete = document !== undefined && DELETEABLE_STATUSES.has(document.status)

  const chunksQuery = useQuery({
    queryKey: ['documents', documentId, 'chunks', chunkPage],
    queryFn: ({ signal }) => api.get<ChunkListResponse>(`${documentPath}/chunks`, {
      query: { offset: (chunkPage - 1) * CHUNK_PAGE_SIZE, limit: CHUNK_PAGE_SIZE },
      signal,
      silent: true,
    }),
    enabled: isReady,
  })
  const chunkDetailQuery = useQuery({
    queryKey: ['documents', documentId, 'chunk', selectedChunkId],
    queryFn: ({ signal }) => api.get<ChunkDetailResponse>(
      `${documentPath}/chunks/${encodeURIComponent(selectedChunkId!)}`, { signal, silent: true },
    ),
    enabled: isReady && selectedChunkId !== null,
  })
  const chunkStatsQuery = useQuery({
    queryKey: ['documents', documentId, 'chunk-stats'],
    queryFn: ({ signal }) => api.get<ChunkStatsResponse>(`${documentPath}/chunks/stats`, {
      signal,
      silent: true,
    }),
    enabled: isReady,
  })
  const retryMutation = useMutation({
    mutationFn: () => api.documents.retry(documentId),
    onSuccess: async (updatedDocument) => {
      await queryClient.cancelQueries({ queryKey: ['documents', documentId] })
      setChunkPage(1)
      setSelectedChunkId(null)
      queryClient.removeQueries({ queryKey: ['documents', documentId] })
      queryClient.setQueryData(['documents', 'detail', documentId], updatedDocument)
      message.success('已重新提交文档解析')
      await queryClient.invalidateQueries({ queryKey: ['documents'], refetchType: 'all' })
    },
  })
  const deleteMutation = useMutation({
    mutationFn: () => api.documents.remove(documentId),
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: ['documents', documentId] })
      await queryClient.cancelQueries({ queryKey: ['documents', 'detail', documentId] })
      await queryClient.cancelQueries({ queryKey: ['document-preview', documentId] })
      queryClient.removeQueries({ queryKey: ['documents', documentId] })
      queryClient.removeQueries({ queryKey: ['documents', 'detail', documentId] })
      queryClient.removeQueries({ queryKey: ['document-preview', documentId] })
      message.success('文档已删除')
      navigate(ROUTE_PATHS.documents, { replace: true })
      await queryClient.invalidateQueries({ queryKey: ['documents'], refetchType: 'all' })
    },
  })
  const busy = retryMutation.isPending || deleteMutation.isPending
  const statusInfo = getDocumentStatusInfo(document?.status)
  const previewSupported = canPreviewInline(document?.mime_type)
  const chunkColumns: ColumnsType<ChunkListItemResponse> = [
    { title: '分块', dataIndex: 'chunk_index', width: 90, render: (index: number) => `#${index + 1}` },
    { title: '正文摘要', dataIndex: 'summary', render: (summary: string) => (
      summary ? (
        <div style={{ overflowWrap: 'anywhere', overflowX: 'auto' }}>
          <MarkdownComponents>{summary}</MarkdownComponents>
        </div>
      ) : '空内容'
    ) },
    { title: '操作', key: 'detail', width: 100, render: (_, chunk) => (
      <Button type="link" onClick={() => setSelectedChunkId(chunk.id)}>查看详情</Button>
    ) },
  ]
  const chunkDetail = isReady ? chunkDetailQuery.data : undefined

  return (
    <section className="kb-stage" aria-labelledby="kb-page-title">
      <StageHead eyebrow="DOCUMENT DETAIL" headline={document?.name ?? '文档详情'}
        description="查看元数据、预览原文件，并浏览切分后的正文内容。" />
      <Flex vertical gap="large">
        <Flex justify="space-between" wrap gap="middle">
          <Link to={ROUTE_PATHS.documents}>返回文档列表</Link>
          <Space wrap>
            <Button icon={<DownloadOutlined />} disabled={!document}
              href={document ? getDocumentDownloadUrl(documentId) : undefined}>下载原文件</Button>
            <Tooltip title={previewSupported ? '在新窗口中预览文档' : '该类型不支持在线预览，请下载查看'}>
              <span>
                <Button icon={<ExportOutlined />} disabled={!document || !previewSupported}
                  href={document && previewSupported ? generatePath(ROUTE_PATHS.documentPreview, { documentId }) : undefined}
                  target="_blank" rel="noopener noreferrer">新窗口打开</Button>
              </span>
            </Tooltip>
            {document?.status === 'failed' && (
              <Button icon={<ReloadOutlined />} loading={retryMutation.isPending} disabled={busy}
                onClick={() => retryMutation.mutate()}>重试解析</Button>
            )}
            <Popconfirm title="确认删除此文档？"
              description="将永久删除文档及分块，同时尝试删除 COS 中的原文件，此操作无法撤销。"
              okText="确认删除" cancelText="取消" okButtonProps={{ danger: true }}
              disabled={!canDelete || busy} onConfirm={() => deleteMutation.mutate()}>
              <Tooltip title={!canDelete ? '文档正在处理中或尚未加载，暂不能删除' : busy ? '操作正在提交，请稍候' : undefined}>
                <span><Button danger icon={<DeleteOutlined />} disabled={!canDelete || busy}
                  loading={deleteMutation.isPending}>删除</Button></span>
              </Tooltip>
            </Popconfirm>
            <Button icon={<ReloadOutlined />} loading={documentQuery.isFetching}
              onClick={() => { void queryClient.invalidateQueries({ queryKey: ['documents'], refetchType: 'all' }) }}>刷新</Button>
          </Space>
        </Flex>
        {documentQuery.isError && <Alert type="error" showIcon title="文档信息加载失败" description={documentQuery.error.message} />}
        <Card title="文档元数据" loading={documentQuery.isLoading}>
          {document ? (
            <Flex vertical gap="middle">
              <Descriptions bordered size="small" column={{ xs: 1, sm: 1, md: 2 }} items={[
                { key: 'id', label: '文档 ID', children: <Typography.Text copyable>{document.id}</Typography.Text> },
                { key: 'name', label: '文件名', children: document.name },
                { key: 'mime', label: 'MIME 类型', children: document.mime_type },
                { key: 'size', label: '文件大小', children: `${document.size.toLocaleString('zh-CN')} 字节` },
                { key: 'status', label: '处理状态', children: <Tag color={statusInfo.color}>{statusInfo.text}</Tag> },
                { key: 'chunks', label: '分块总数', children: isReady && chunksQuery.isSuccess ? chunksQuery.data.total : '—' },
                { key: 'created', label: '上传时间', children: new Date(document.created_at).toLocaleString('zh-CN') },
                { key: 'updated', label: '更新时间', children: new Date(document.updated_at).toLocaleString('zh-CN') },
              ]} />
              {document.error_message && <Alert type="error" showIcon title="处理失败" description={document.error_message} />}
            </Flex>
          ) : <Empty description="暂无文档信息" />}
        </Card>
        <Card title="原文预览">
          {document ? <DocumentPreview document={document} /> : <Empty description="加载文档信息后显示原文" />}
        </Card>
        <Card title="切分结果" extra={<Tag color={statusInfo.color}>{statusInfo.text}</Tag>}>
          <Flex vertical gap="middle">
            <Alert showIcon type={document?.status === 'failed' ? 'error' : isReady ? 'success' : 'info'}
              title={isReady ? '文档处理完成，可以查看分块'
                : document?.status === 'failed' ? '文档处理失败，请先重试解析' : '文档处理中，就绪后自动加载分块'}
              description="分块没有独立处理状态，本区域展示所属文档的处理状态。" />
            {isReady && (
              <Spin spinning={chunkStatsQuery.isFetching}>
                {chunkStatsQuery.isError ? (
                  <Alert type="error" showIcon title="分块统计加载失败"
                    action={<Button onClick={() => { void chunkStatsQuery.refetch() }}>重试统计</Button>} />
                ) : (
                  <Descriptions title="分块统计" bordered size="small" column={{ xs: 1, sm: 2, lg: 4 }} items={[
                    { key: 'count', label: '分块数量', children: chunkStatsQuery.data?.count ?? '—' },
                    { key: 'avg', label: '平均正文长度（字符）', children: chunkStatsQuery.data?.avg?.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) ?? '—' },
                    { key: 'min', label: '最短正文（字符）', children: chunkStatsQuery.data?.min ?? '—' },
                    { key: 'max', label: '最长正文（字符）', children: chunkStatsQuery.data?.max ?? '—' },
                  ]} />
                )}
              </Spin>
            )}
            {chunksQuery.isError && isReady && <Alert type="error" showIcon title="分块列表加载失败"
              action={<Button onClick={() => { void chunksQuery.refetch() }}>重试</Button>} />}
            <Table<ChunkListItemResponse> rowKey="id" columns={chunkColumns}
              dataSource={isReady ? chunksQuery.data?.items ?? [] : []}
              loading={isReady && chunksQuery.isFetching} scroll={{ x: 800 }}
              locale={{ emptyText: isReady ? chunksQuery.isError ? '分块加载失败，请重试' : '暂无分块' : '等待文档就绪' }}
              pagination={{ current: chunkPage, pageSize: CHUNK_PAGE_SIZE,
                total: isReady ? chunksQuery.data?.total ?? 0 : 0, showSizeChanger: false,
                onChange: (page) => { setChunkPage(page); setSelectedChunkId(null) },
                showTotal: (total) => `共 ${total} 个分块` }} />
          </Flex>
        </Card>
      </Flex>
      <Modal title={chunkDetail ? `分块 #${chunkDetail.chunk_index + 1}` : '分块详情'}
        open={selectedChunkId !== null && isReady} onCancel={() => setSelectedChunkId(null)}
        footer={null} width={900}>
        <Spin spinning={chunkDetailQuery.isFetching}>
          {chunkDetailQuery.isError && <Alert type="error" showIcon title="分块详情加载失败"
            action={<Button onClick={() => { void chunkDetailQuery.refetch() }}>重试</Button>} />}
          {chunkDetail && (
            <Flex vertical gap="middle">
              <Descriptions bordered size="small" column={1} items={[
                { key: 'id', label: '分块 ID', children: <Typography.Text copyable>{chunkDetail.id}</Typography.Text> },
                { key: 'document', label: '所属文档', children: chunkDetail.document_id },
                { key: 'page', label: '页码', children: chunkDetail.page_no ?? '—' },
                { key: 'section', label: '章节', children: chunkDetail.section_path || '—' },
                { key: 'created', label: '创建时间', children: new Date(chunkDetail.created_at).toLocaleString('zh-CN') },
              ]} />
              <Typography.Title level={5}>完整正文</Typography.Title>
              {document && isMarkdownDocument(document) ? (
                <div style={{ overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>
                  <MarkdownComponents>{chunkDetail.content}</MarkdownComponents>
                </div>
              ) : (
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{chunkDetail.content}</pre>
              )}
              <Typography.Title level={5}>解析元数据</Typography.Title>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(chunkDetail.extra_metadata ?? {}, null, 2)}</pre>
            </Flex>
          )}
        </Spin>
      </Modal>
    </section>
  )
}
