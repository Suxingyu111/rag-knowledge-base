import { Grid, Table, Tag, Tooltip } from 'antd'
import type { TableColumnsType, TableProps } from 'antd'

import type { EvaluationItemRead, EvaluationRunRead } from '@/client'
import {
  BAD_CASE_CATEGORY_LABELS, formatDate, formatLatency, formatQueryStrategy, formatRate, RAGAS_METRICS,
} from './evaluationPresentation'

const scoreColumns: TableColumnsType<EvaluationItemRead> = RAGAS_METRICS.map(({ key, name }) => ({
  title: name,
  key,
  width: 107,
  align: 'right',
  className: 'evaluation-number',
  render: (_, item) => item[key] == null && item.should_refuse
    ? <span className="evaluation-muted">不适用</span>
    : formatRate(item[key]),
}))

export default function EvaluationItemsTable({ status, onSelect, ...tableProps }: {
  status: EvaluationRunRead['status']
  onSelect: (item: EvaluationItemRead) => void
} & Pick<TableProps<EvaluationItemRead>, 'dataSource' | 'loading' | 'locale' | 'pagination'>) {
  const { lg } = Grid.useBreakpoint()
  const columns: TableColumnsType<EvaluationItemRead> = [
    {
      title: '编号 / 问题', key: 'question', width: 248, fixed: lg ? 'start' : undefined,
      render: (_, item) => (
        <>
          <span className="evaluation-muted">{item.case_id}</span>
          <button type="button" className="evaluation-question" onClick={(event) => {
            event.stopPropagation()
            onSelect(item)
          }}>{item.question}</button>
          {!!item.tags?.length && <div className="evaluation-item-tags">{item.tags.join(' · ')}</div>}
        </>
      ),
    },
    {
      title: '作答与归因', key: 'outcome', children: [
        {
          title: '预期 / 实际', key: 'response', width: 130,
          render: (_, item) => (
            <>
              <div className="evaluation-muted">预期：{item.should_refuse ? '拒答' : '作答'}</div>
              {item.error_message ? (
                <Tooltip title={item.error_message}><Tag color="error">执行异常</Tag></Tooltip>
              ) : (
                <Tag color={item.refusal_correct ? 'success' : 'error'}>
                  实际：{item.actual_refused ? '拒答' : '作答'}
                </Tag>
              )}
            </>
          ),
        },
        {
          title: 'Bad Case 归因', key: 'category', width: 172,
          render: (_, item) => {
            if (item.is_bad_case) {
              const label = item.bad_case_category ? BAD_CASE_CATEGORY_LABELS[item.bad_case_category] : '待归因'
              return (
                <>
                  <Tag color="warning">{label}</Tag>
                  {item.bad_case_note && (
                    <div className="evaluation-note" title={item.bad_case_note}>{item.bad_case_note}</div>
                  )}
                </>
              )
            }
            if (status === 'running') return <span className="evaluation-muted">待汇总</span>
            return '—'
          },
        },
      ],
    },
    { title: '质量指标', key: 'quality', children: scoreColumns },
    {
      title: '检索与验证', key: 'retrieval', children: [
        { title: '引用命中', key: 'citation', width: 88, render: (_, item) =>
          item.citation_hit == null
            ? <span className="evaluation-muted">{item.should_refuse ? '不适用' : '—'}</span>
            : <Tag color={item.citation_hit ? 'success' : 'warning'}>{item.citation_hit ? '命中' : '未命中'}</Tag> },
        { title: '查询策略', key: 'route', width: 96, render: (_, item) => formatQueryStrategy(item.query_route?.route) },
        {
          title: '答案验证', key: 'verify', width: 94,
          render: (_, item) => {
            const result = item.verify_result?.verified
            if (typeof result !== 'boolean') return '—'
            const reason = item.verify_result?.reason
            return (
              <Tooltip title={typeof reason === 'string' ? reason : undefined}>
                <Tag color={result ? 'success' : 'error'}>{result ? '通过' : '未通过'}</Tag>
              </Tooltip>
            )
          },
        },
        {
          title: '证据数量', key: 'evidence', width: 105,
          render: (_, item) => (
            <>
              <div>召回 {item.retrieved_chunks_meta?.length ?? 0}</div>
              <div className="evaluation-muted">引用 {item.citations?.length ?? 0}</div>
            </>
          ),
        },
      ],
    },
    {
      title: '性能', key: 'timing', children: [
        { title: '总耗时', key: 'latency', width: 90, align: 'right', className: 'evaluation-number',
          render: (_, item) => formatLatency(item.latency_ms) },
        { title: '首 Token 耗时', key: 'firstToken', width: 121, align: 'right', className: 'evaluation-number',
          render: (_, item) => formatLatency(item.first_token_latency_ms) },
      ],
    },
    { title: '记录时间', key: 'created', width: 156, className: 'evaluation-number',
      render: (_, item) => formatDate(item.created_at) },
  ]

  return (
    <Table<EvaluationItemRead>
      {...tableProps}
      rowKey="id"
      size="small"
      columns={columns}
      scroll={{ x: 1730 }}
      onRow={(item) => ({ onClick: () => onSelect(item), className: 'evaluation-item-row' })}
    />
  )
}
