import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Card, Space, Spin, Switch } from 'antd'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { isApiError } from '@/api/client'
import { evaluationApi, evaluationKeys } from '@/api/evaluation'
import type { BadCaseCategory } from '@/api/evaluation'
import type { EvaluationItemRead } from '@/client'
import { BadCaseCategorySelect, EvaluationRequestError, RunProgress, RunStatusTag } from '@/components/evaluation/EvaluationControls'
import EvaluationItemDrawer from '@/components/evaluation/EvaluationItemDrawer'
import EvaluationItemsTable from '@/components/evaluation/EvaluationItemsTable'
import EvaluationMetricCard from '@/components/evaluation/EvaluationMetricCard'
import {
  formatDate, formatLatency, formatRate, POLL_INTERVAL, RUN_METRICS,
} from '@/components/evaluation/evaluationPresentation'
import { ROUTE_PATHS } from '@/routes/paths'
import './EvaluationPages.css'

export default function EvaluationDetailPage() {
  const { runId = '' } = useParams()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [badOnly, setBadOnly] = useState(false)
  const [category, setCategory] = useState<BadCaseCategory>()
  const [selected, setSelected] = useState<EvaluationItemRead>()

  const runQuery = useQuery({
    queryKey: evaluationKeys.run(runId),
    queryFn: ({ signal }) => evaluationApi.run(runId, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: ({ state }) => state.data?.status === 'running' && !(isApiError(state.error) && state.error.status === 404) ? POLL_INTERVAL : false,
  })
  const run = runQuery.data
  const running = run?.status === 'running'
  const started = run?.started_at ? Date.parse(run.started_at) : undefined
  const finished = run?.finished_at ? Date.parse(run.finished_at) : undefined
  const durationMs = started !== undefined && finished !== undefined && finished >= started
    ? finished - started
    : undefined
  const durationSeconds = Math.floor((durationMs ?? 0) / 1000)
  const duration = durationSeconds >= 60
    ? `${Math.floor(durationSeconds / 60)} 分 ${durationSeconds % 60} 秒`
    : formatLatency(durationMs)
  const filters = { page, page_size: pageSize, bad_case_only: badOnly, category }
  const items = useQuery({
    // 状态切换后立即读取结算后的样本和归因，即使上一次请求恰好发生在结算前。
    queryKey: [...evaluationKeys.items(runId), filters, run?.status],
    queryFn: ({ signal }) => evaluationApi.items(runId, filters, signal),
    enabled: Boolean(run),
    staleTime: 0,
    refetchInterval: running && !(isApiError(runQuery.error) && runQuery.error.status === 404) ? POLL_INTERVAL : false,
  })
  const lastPage = Math.max(1, Math.ceil((items.data?.total ?? 0) / pageSize))
  // 筛选结果因人工归因减少时，返回最后一个有效页。
  if (items.data && page > lastPage) setPage(lastPage)
  const selectedItem = items.data?.items.find((item) => item.id === selected?.id) ?? selected

  return (
    <section className="evaluation-page" aria-labelledby="kb-page-title">
      <Link className="evaluation-back" to={ROUTE_PATHS.evaluations}><ArrowLeftOutlined /> 评测列表</Link>
      <header className="evaluation-header">
        <div>
          <h1 id="kb-page-title">{run?.name ?? '评测详情'}</h1>
          {run && <p>评测集 {run.dataset_name} · {run.dataset_size} 条样本</p>}
        </div>
        {run && (
          <Space wrap>
            <RunStatusTag status={run.status} />
            <Button icon={<ReloadOutlined />} loading={runQuery.isFetching || items.isFetching} onClick={() => {
              void runQuery.refetch()
              void items.refetch()
            }}>刷新</Button>
          </Space>
        )}
      </header>
      {runQuery.error && <EvaluationRequestError error={runQuery.error} retry={() => void runQuery.refetch()} />}
      {runQuery.isPending && <Spin />}
      {run && (
        <>
          <section className="evaluation-metrics" aria-label="评测汇总指标">
            {RUN_METRICS.map(({ key, name, description }) => (
              <EvaluationMetricCard key={key} name={name} description={description}
                value={key.endsWith('_ms') ? formatLatency(run[key]) : formatRate(run[key])} />
            ))}
          </section>
          {run.error_message && <Alert type="error" showIcon title="评测执行失败" description={run.error_message} />}
          <Card size="small" className="evaluation-run-meta">
            <div>
              <strong>{running && run.progress_completed >= run.progress_total ? '正在汇总指标和归因' : '样本处理进度'}</strong>
              <RunProgress run={run} />
            </div>
            <dl>
              <div><dt>创建</dt><dd>{formatDate(run.created_at)}</dd></div>
              <div><dt>开始</dt><dd>{formatDate(run.started_at)}</dd></div>
              <div><dt>结束</dt><dd>{formatDate(run.finished_at)}</dd></div>
              <div><dt>任务总用时</dt><dd>{duration}</dd></div>
            </dl>
          </Card>
          {items.error && <EvaluationRequestError error={items.error} retry={() => void items.refetch()} />}
          <Card className="evaluation-table" title="样本结果" extra={items.data && (
            <span className="evaluation-muted">
              {badOnly || category ? `匹配 ${items.data.total} 条` : `共 ${items.data.total} 条`}
            </span>
          )}>
            <div className="evaluation-filters" role="group" aria-label="筛选样本">
              <label>
                <Switch size="small" aria-label="仅 Bad Case" checked={badOnly}
                  onChange={(value) => { setBadOnly(value); setPage(1) }} />
                仅 Bad Case
              </label>
              <BadCaseCategorySelect allowClear value={category} placeholder="全部归因"
                onChange={(value) => { setCategory(value); setPage(1) }} />
              {(badOnly || category) && (
                <Button type="link" onClick={() => { setBadOnly(false); setCategory(undefined); setPage(1) }}>
                  清除筛选
                </Button>
              )}
            </div>
            <EvaluationItemsTable
              status={run.status}
              onSelect={setSelected}
              dataSource={items.data?.items}
              loading={items.isPending}
              locale={{ emptyText: items.isError ? '样本加载失败' : running ? '暂时没有匹配的样本结果' : '没有匹配的样本结果' }}
              pagination={{
                current: page, pageSize, total: items.data?.total,
                showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100],
                onChange: (nextPage, nextSize) => {
                  setPage(nextSize === pageSize ? nextPage : 1)
                  setPageSize(nextSize)
                },
              }}
            />
          </Card>
          {selectedItem && (
            <EvaluationItemDrawer key={selectedItem.id} item={selectedItem} status={run.status}
              onClose={() => setSelected(undefined)} />
          )}
        </>
      )}
    </section>
  )
}
