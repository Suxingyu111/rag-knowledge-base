import { DeleteOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Empty, Flex, Popconfirm, Space, Table, Tag, Tooltip, Typography, Upload } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import { generatePath, Link } from 'react-router-dom'

import { api } from '@/api/client'
import type { DocumentListResponse, DocumentResponse, DocumentStatus, DocumentStatusResponse } from '@/client/types.gen'
import StageHead from '@/components/StageHead'
import { ROUTE_PATHS } from '@/routes/paths'
import { getDocumentStatusInfo, isTerminalStatus } from '@/utils/documentStatus'

// 与 DocumentService._DELETEABLE_STATUSES 保持一致；后端仍负责最终校验。
const DELETEABLE_STATUSES: ReadonlySet<DocumentStatus> = new Set(['ready', 'failed', 'uploading'])
const PAGE_SIZE = 20
const POLL_INTERVAL = 2_000
const DOCUMENTS_KEY = ['documents'] as const


const FILE_TYPE_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'text/markdown': 'Markdown',
  'text/x-markdown': 'Markdown',
  'text/plain': 'TXT',
  'text/html': 'HTML',
  'application/xhtml+xml': 'HTML',
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function DocumentsPage() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const listQuery = useQuery({
    queryKey: [...DOCUMENTS_KEY, page],
    queryFn: ({ signal }) => api.get<DocumentListResponse>('/documents', {
      query: { offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE },
      signal,
      silent: true,
    }),
    staleTime: 0,
  })
  const documents = listQuery.data?.items ?? []
  const statusQueries = useQueries({
    queries: documents.map((document) => ({
      queryKey: ['document-status', document.id, document.updated_at],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.get<DocumentStatusResponse>(
        `/documents/${encodeURIComponent(document.id)}/status`, { signal, silent: true },
      ),
      enabled: !isTerminalStatus(document.status),
      refetchInterval: (query: { state: { data?: DocumentStatusResponse; status: string } }) =>
        query.state.status === 'error' || isTerminalStatus(query.state.data?.status)
          ? false : POLL_INTERVAL,
      retry: 1,
    })),
  })
  const rows = documents.map((document, index) => {
    const status = statusQueries[index]?.data
    return status && Date.parse(status.updated_at) >= Date.parse(document.updated_at)
      ? { ...document, ...status } : document
  })

  async function refreshDocuments() {
    // 前缀匹配所有分页缓存，包括当前未挂载的列表查询。
    await queryClient.invalidateQueries({ queryKey: DOCUMENTS_KEY, refetchType: 'all' })
  }

  const uploadMutation = useMutation({
    mutationFn: (file: File) => api.documents.upload(file),
    onSuccess: async (document, file) => {
      if (document.name !== file.name || documents.some((item) => item.id === document.id)) {
        message.info(`相同内容已存在，复用文档「${document.name}」，不会新增记录`)
      } else {
        message.success(`文档已接收：${document.name}（相同内容自动去重）`)
      }
      setPage(1)
      await refreshDocuments()
    },
  })
  const deleteMutation = useMutation({
    mutationFn: (documentId: string) => {
      const document = rows.find((record) => record.id === documentId)
      if (!document || !DELETEABLE_STATUSES.has(document.status)) {
        throw new Error('文档正在处理中，暂不能删除')
      }
      return api.documents.remove(documentId)
    },
    onSuccess: async (_, documentId) => {
      await queryClient.cancelQueries({ queryKey: ['document-status', documentId] })
      queryClient.removeQueries({ queryKey: ['document-status', documentId] })
      message.success('文档已删除')
      if (rows.length === 1 && page > 1) setPage(page - 1)
      await refreshDocuments()
    },
    onError: () => { void refreshDocuments() },
  })
  const retryMutation = useMutation({
    mutationFn: (documentId: string) => api.documents.retry(documentId),
    onSuccess: async (_, documentId) => {
      await queryClient.cancelQueries({ queryKey: ['document-status', documentId] })
      queryClient.removeQueries({ queryKey: ['document-status', documentId] })
      message.success('已重新开始处理')
      await refreshDocuments()
    },
    onError: () => { void refreshDocuments() },
  })
  const busy = deleteMutation.isPending || retryMutation.isPending
  const columns: ColumnsType<DocumentResponse> = [
    {
      title: '文档名称 / ID',
      dataIndex: 'name',
      width: 330,
      render: (name: string, record) => (
        <Flex vertical gap={4}>
          <Link
            to={generatePath(ROUTE_PATHS.documentDetail, { documentId: record.id })}
            style={{ overflowWrap: 'anywhere' }}
          >
            {name}
          </Link>
          <Typography.Text
            type="secondary"
            copyable={{ text: record.id }}
            style={{ fontSize: 12, overflowWrap: 'anywhere' }}
          >
            ID：{record.id}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: '文件类型',
      dataIndex: 'mime_type',
      width: 120,
      render: (mimeType: string) => (
        <Tooltip title={mimeType}>
          <Tag>{FILE_TYPE_LABELS[mimeType] ?? '其他'}</Tag>
        </Tooltip>
      ),
    },
    {
      title: '文件大小',
      dataIndex: 'size',
      width: 120,
      render: (size: number) => (
        <Tooltip title={`${size.toLocaleString('zh-CN')} 字节`}>
          <span>{formatFileSize(size)}</span>
        </Tooltip>
      ),
    },
    {
      title: '处理状态 / 失败原因',
      key: 'status',
      width: 260,
      render: (_, record) => {
        const info = getDocumentStatusInfo(record.status)
        return (
          <Flex vertical align="start" gap={4}>
            <Tag color={info.color}>{info.text}</Tag>
            {record.error_message && (
              <Typography.Text
                type="danger"
                ellipsis={{ tooltip: record.error_message }}
                style={{ maxWidth: 230, fontSize: 12 }}
              >
                {record.error_message}
              </Typography.Text>
            )}
          </Flex>
        )
      },
    },
    {
      title: '上传时间',
      dataIndex: 'created_at',
      width: 190,
      render: (value: string) => new Date(value).toLocaleString('zh-CN'),
    },
    {
      title: '最近更新',
      dataIndex: 'updated_at',
      width: 190,
      render: (value: string) => new Date(value).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 190,
      fixed: 'right',
      render: (_, record) => {
        const deletable = DELETEABLE_STATUSES.has(record.status)
        const deleteDisabled = !deletable || busy
        const deleteDisabledReason = !deletable
          ? '文档正在处理中，暂不能删除，请等待处理完成。'
          : busy ? '正在提交文档操作，请稍候。' : undefined

        return (
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              disabled={record.status !== 'failed' || busy}
              loading={retryMutation.isPending && retryMutation.variables === record.id}
              onClick={() => retryMutation.mutate(record.id)}
            >
              重试
            </Button>
            <Popconfirm
              title="确认删除此文档？"
              description="将永久删除文档及关联分块，同时尝试删除 COS 中的原文件，此操作无法撤销。"
              okText="确认删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              disabled={deleteDisabled}
              onConfirm={() => deleteMutation.mutate(record.id)}
            >
              <Tooltip title={deleteDisabledReason}>
                {/* span 接收禁用按钮无法接收的鼠标事件，保证 Tooltip 可触发。 */}
                <span style={{ display: 'inline-block' }}>
                  <Button
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    disabled={deleteDisabled}
                    loading={deleteMutation.isPending && deleteMutation.variables === record.id}
                  >
                    删除
                  </Button>
                </span>
              </Tooltip>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  return (
    <section className="kb-stage" aria-labelledby="kb-page-title">
      <StageHead
        eyebrow="DOCUMENTS"
        headline="文档管理"
        description="上传资料，查看处理进度，管理已入库或处理失败的文档。"
      />

      <Flex vertical gap="large">
        <Flex wrap gap="middle" align="center" justify="space-between">
          <Upload
            accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm"
            multiple={false}
            showUploadList={false}
            disabled={uploadMutation.isPending}
            customRequest={({ file, onSuccess, onError }) => {
              // 未配置文件转换，Upload 传入的是用户选择的 File。
              uploadMutation.mutate(file as File, {
                onSuccess: (document) => onSuccess?.(document),
                // SDK 已通过全局拦截器提示，此处只同步 Upload 的失败状态。
                onError: (error) => onError?.(error),
              })
            }}
          >
            <Button
              type="primary"
              icon={<UploadOutlined />}
              loading={uploadMutation.isPending}
              disabled={uploadMutation.isPending}
            >
              {uploadMutation.isPending ? '正在上传' : '上传文档'}
            </Button>
          </Upload>
          <span>支持 PDF、DOCX、Markdown、TXT、HTML，每次上传一个文件</span>
        </Flex>

        {listQuery.isError && (
          <Alert
            type="error"
            showIcon
            title="文档列表加载失败"
            description="请点击刷新重试；已有列表数据将保留展示。"
          />
        )}
        {statusQueries.some((query) => query.isError) && (
          <Alert
            type="warning"
            showIcon
            title="部分文档状态更新失败"
            description="当前显示上次结果，请点击刷新重新查询状态。"
          />
        )}

        <Card
          title="文档列表"
          extra={
            <Button
              icon={<ReloadOutlined />}
              loading={listQuery.isFetching}
              onClick={() => {
                void refreshDocuments()
                void queryClient.invalidateQueries({ queryKey: ['document-status'] })
              }}
            >
              刷新
            </Button>
          }
        >
          <Table<DocumentResponse>
            rowKey="id"
            columns={columns}
            dataSource={rows}
            loading={listQuery.isFetching}
            scroll={{ x: 1400 }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={listQuery.isError ? '暂时无法获取文档，请刷新重试' : '暂无文档，点击上方按钮上传资料'}
                />
              ),
            }}
            pagination={{
              current: page,
              pageSize: PAGE_SIZE,
              total: listQuery.data?.total ?? 0,
              showSizeChanger: false,
              onChange: setPage,
              showTotal: (total) => `共 ${total} 份文档`,
            }}
          />
        </Card>

        <p className="kb-stage-note">
          处理中的文档每 2 秒自动更新状态；解析失败后可重试，失败原因展示在状态下方，点击文档名称可进入详情页。
        </p>
      </Flex>
    </section>
  )
}

export default DocumentsPage
