import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Card, Form, Grid, Input, Modal, Select, Space, Table } from 'antd'
import type { TableColumnsType } from 'antd'
import { useState } from 'react'
import { generatePath, Link, useNavigate } from 'react-router-dom'

import { evaluationApi, evaluationKeys } from '@/api/evaluation'
import type { EvaluationRunCreate, EvaluationRunListItem } from '@/client'
import { EvaluationRequestError, RunProgress, RunStatusTag } from '@/components/evaluation/EvaluationControls'
import { formatDate, formatLatency, formatRate, POLL_INTERVAL, RUN_METRICS } from '@/components/evaluation/evaluationPresentation'
import { ROUTE_PATHS } from '@/routes/paths'
import './EvaluationPages.css'

const runMetricColumns: TableColumnsType<EvaluationRunListItem> = RUN_METRICS.map(({ key, name }) => ({
  title: name,
  key,
  width: key === 'avg_first_token_latency_ms' ? 138 : 102,
  align: 'right',
  className: 'evaluation-number',
  render: (_, run) => key.endsWith('_ms') ? formatLatency(run[key]) : formatRate(run[key]),
}))

export default function EvaluationsPage() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const { lg } = Grid.useBreakpoint()
  const [creating, setCreating] = useState(false)
  const [form] = Form.useForm<EvaluationRunCreate>()
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const runs = useQuery({
    queryKey: [...evaluationKeys.runs, page, pageSize],
    queryFn: ({ signal }) => evaluationApi.runs(page, pageSize, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: ({ state }) =>
      state.data?.items.some((run) => run.status === 'running') ? POLL_INTERVAL : false,
  })
  const datasets = useQuery({
    queryKey: evaluationKeys.datasets,
    queryFn: ({ signal }) => evaluationApi.datasets(signal),
    enabled: creating,
    staleTime: 0,
  })
  const options = (datasets.data?.items ?? []).map(({ name, size }) => ({
    value: name, label: `${name} · ${size} 条样本`, disabled: size === 0,
  }))

  const create = useMutation({
    mutationFn: (body: EvaluationRunCreate) => evaluationApi.create({ ...body, name: body.name.trim() }),
    onSuccess: (run) => {
      queryClient.setQueryData(evaluationKeys.run(run.id), run)
      void queryClient.invalidateQueries({ queryKey: evaluationKeys.runs })
      void message.success('评测已创建')
      navigate(generatePath(ROUTE_PATHS.evaluationDetail, { runId: run.id }))
    },
  })

  const remove = useMutation({
    mutationFn: evaluationApi.remove,
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: evaluationKeys.run(id) })
      queryClient.removeQueries({ queryKey: evaluationKeys.items(id) })
      if (runs.data?.items.length === 1 && page > 1) setPage(page - 1)
      void queryClient.invalidateQueries({ queryKey: evaluationKeys.runs })
      void message.success('评测已删除')
    },
  })

  function confirmRemove(run: EvaluationRunListItem) {
    modal.confirm({
      title: '删除评测',
      content: `将永久删除「${run.name}」及其所有样本结果。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => remove.mutateAsync(run.id),
    })
  }

  return (
    <section className="evaluation-page" aria-labelledby="kb-page-title">
      <header className="evaluation-header">
        <div>
          <h1 id="kb-page-title">评测分析</h1>
          <p>运行评测集，查看问答质量、检索表现和异常样本。</p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={runs.isFetching} onClick={() => void runs.refetch()}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>新建评测</Button>
        </Space>
      </header>
      {runs.error && <EvaluationRequestError error={runs.error} retry={() => void runs.refetch()} />}
      <Card className="evaluation-table" title="评测记录" extra={runs.data && `共 ${runs.data.total} 次`}>
        <Table<EvaluationRunListItem>
          rowKey="id"
          size="small"
          loading={runs.isPending}
          dataSource={runs.data?.items}
          locale={{ emptyText: runs.isError ? '评测记录加载失败' : '暂无评测记录' }}
          scroll={{ x: 1597 }}
          pagination={{
            current: page, pageSize, total: runs.data?.total,
            showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100],
            onChange: (nextPage, nextSize) => {
              setPage(nextSize === pageSize ? nextPage : 1)
              setPageSize(nextSize)
            },
          }}
          columns={[
            {
              title: '评测名称', key: 'name', width: 184, fixed: lg ? 'start' : undefined,
              render: (_, run) => (
                <Link className="evaluation-name" to={generatePath(ROUTE_PATHS.evaluationDetail, { runId: run.id })}>
                  {run.name}
                </Link>
              ),
            },
            {
              title: '评测集', key: 'dataset', width: 108,
              render: (_, run) => <>{run.dataset_name}<div className="evaluation-muted">{run.dataset_size} 条样本</div></>,
            },
            { title: '状态', key: 'status', width: 86, render: (_, run) => <RunStatusTag status={run.status} /> },
            { title: '进度', key: 'progress', width: 132, render: (_, run) => <RunProgress run={run} /> },
            { title: '质量指标', key: 'quality', children: runMetricColumns.slice(0, 6) },
            { title: '性能', key: 'timings', children: runMetricColumns.slice(6) },
            { title: '创建时间', key: 'created', width: 156, className: 'evaluation-number', render: (_, run) => formatDate(run.created_at) },
            {
              title: '操作', key: 'actions', width: 74, fixed: lg ? 'end' : undefined,
              render: (_, run) => (
                <Button type="link" danger disabled={run.status === 'running' || remove.isPending}
                  title={run.status === 'running' ? '请在评测结束后删除' : undefined}
                  onClick={() => confirmRemove(run)}>
                  删除
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title="新建评测"
        open={creating}
        onCancel={() => { setCreating(false); form.resetFields(); create.reset() }}
        onOk={() => form.submit()}
        okText="开始评测"
        cancelText="取消"
        confirmLoading={create.isPending}
        okButtonProps={{ disabled: datasets.isError || !options.some(({ disabled }) => !disabled) }}
        cancelButtonProps={{ disabled: create.isPending }}
        keyboard={!create.isPending}
        mask={{ closable: !create.isPending }}
        closable={!create.isPending}
      >
        {datasets.error && <EvaluationRequestError error={datasets.error} retry={() => void datasets.refetch()} />}
        {create.error && <p role="alert" className="evaluation-error-count">{create.error.message}</p>}
        <Form form={form} layout="vertical" onFinish={(body) => create.mutate(body)} disabled={create.isPending}>
          <Form.Item name="name" label="评测名称" rules={[{ required: true, whitespace: true, message: '请输入评测名称' }]}>
            <Input maxLength={256} placeholder="例如：知识库基线评测" />
          </Form.Item>
          <Form.Item name="dataset_name" label="评测集" rules={[{ required: true, message: '请选择评测集' }]}>
            <Select loading={datasets.isPending} options={options} placeholder="选择评测集" notFoundContent="暂无可用评测集" />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  )
}
