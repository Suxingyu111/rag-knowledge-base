import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Collapse, Descriptions, Drawer, Form, Input, Switch, Tag, Typography } from 'antd'

import { evaluationApi, evaluationKeys } from '@/api/evaluation'
import type { EvaluationItemRead, EvaluationItemUpdate, EvaluationRunRead } from '@/client'
import MarkdownComponents from '@/components/MarkdownComponents'
import { BadCaseCategorySelect, EvaluationRequestError } from './EvaluationControls'
import {
  BAD_CASE_CATEGORY_LABELS, formatDate, formatLatency, formatQueryStrategy, formatRate, POLL_INTERVAL, RAGAS_METRICS,
} from './evaluationPresentation'

function AttributionForm({ item, status }: { item: EvaluationItemRead; status: EvaluationRunRead['status'] }) {
  const [form] = Form.useForm<EvaluationItemUpdate>()
  const { message } = App.useApp()
  const client = useQueryClient()
  const update = useMutation({
    onMutate: () => client.cancelQueries({ queryKey: evaluationKeys.item(item.id) }),
    mutationFn: (values: EvaluationItemUpdate) => evaluationApi.updateItem(item.id, {
      is_bad_case: values.is_bad_case,
      bad_case_category: values.is_bad_case ? values.bad_case_category : null,
      bad_case_note: values.bad_case_note?.trim() ?? '',
    }),
    onSuccess: (saved) => {
      client.setQueryData([...evaluationKeys.item(item.id), status], saved)
      form.setFieldsValue({
        is_bad_case: saved.is_bad_case,
        bad_case_category: saved.bad_case_category ?? undefined,
        bad_case_note: saved.bad_case_note ?? '',
      })
      void client.invalidateQueries({ queryKey: evaluationKeys.items(item.run_id) })
      void message.success('归因已更新')
    },
  })

  return (
    <Form<EvaluationItemUpdate>
      form={form}
      layout="vertical"
      initialValues={{
        is_bad_case: item.is_bad_case,
        bad_case_category: item.bad_case_category ?? undefined,
        bad_case_note: item.bad_case_note ?? '',
      }}
      disabled={update.isPending}
      onFinish={(values) => update.mutate(values)}
    >
      <Form.Item name="is_bad_case" label="标记为 Bad Case" valuePropName="checked">
        <Switch />
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(previous, current) => previous.is_bad_case !== current.is_bad_case}>
        {({ getFieldValue }) => (
          <Form.Item name="bad_case_category" label="归因类别">
            <BadCaseCategorySelect disabled={update.isPending || !getFieldValue('is_bad_case')} placeholder="选择归因类别" />
          </Form.Item>
        )}
      </Form.Item>
      <Form.Item name="bad_case_note" label="备注">
        <Input.TextArea rows={3} placeholder="记录判断依据或补充说明" />
      </Form.Item>
      {update.error && <p role="alert" className="evaluation-error-count">{update.error.message}</p>}
      <Button type="primary" htmlType="submit" loading={update.isPending}>保存归因</Button>
    </Form>
  )
}

function readText(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function EvidenceList({ entries, textField }: {
  entries: Record<string, unknown>[]
  textField: 'content' | 'quote'
}) {
  if (!entries.length) return <span className="evaluation-muted">无记录</span>
  return (
    <Collapse size="small" items={entries.map((entry, index) => {
      const ordinal = readText(entry.ordinal) ?? index + 1
      const name = readText(entry.document_name) ?? '未命名文档'
      const page = readText(entry.page_no)
      const section = readText(entry.section_path)
      const score = (key: string) => typeof entry[key] === 'number' ? entry[key].toFixed(4) : '—'

      return {
        key: index,
        label: [`[${ordinal}] ${name}`, page ? `第 ${page} 页` : '', section].filter(Boolean).join(' · '),
        children: (
          <>
            <p className="evaluation-muted">
              {textField === 'quote' ? `引用分数 ${score('score')}` :
                `向量 ${score('vector_score')} · RRF ${score('rrf_score')} · rerank ${score('rerank_score')}`}
            </p>
            <p className="evaluation-evidence-text">{readText(entry[textField]) || '无文本'}</p>
            <details><summary>原始记录</summary><pre className="evaluation-json">{JSON.stringify(entry, null, 2)}</pre></details>
          </>
        ),
      }
    })} />
  )
}

export default function EvaluationItemDrawer({ item: snapshot, status, onClose }: {
  item: EvaluationItemRead
  status: EvaluationRunRead['status']
  onClose: () => void
}) {
  const query = useQuery({
    queryKey: [...evaluationKeys.item(snapshot.id), status],
    queryFn: ({ signal }) => evaluationApi.item(snapshot.id, signal),
    placeholderData: snapshot,
    staleTime: 0,
    refetchInterval: status === 'running' ? POLL_INTERVAL : false,
  })
  const item = query.data ?? snapshot
  const category = item.bad_case_category
  const route = item.query_route
  const multiQueries = Array.isArray(route?.multi_queries)
    ? route.multi_queries.filter((value): value is string => typeof value === 'string')
    : []
  const verified = item.verify_result?.verified

  return (
    <Drawer open onClose={onClose} title={`样本详情 · ${item.case_id}`} size="large">
      <div className="evaluation-drawer">
        {query.error && <EvaluationRequestError error={query.error} retry={() => void query.refetch()} />}
        <section>
          <h2>{item.question}</h2>
          {item.tags?.map((tag, index) => <Tag key={index}>{tag}</Tag>)}
          {item.is_bad_case && <Tag color="warning">{category ? BAD_CASE_CATEGORY_LABELS[category] : 'Bad Case · 待归因'}</Tag>}
        </section>
        {item.error_message && <Alert type="error" showIcon title="样本执行异常" description={item.error_message} />}
        <div className="evaluation-answers">
          <Card size="small" title="预期答案" extra={<Tag>{item.should_refuse ? '应拒答' : '应作答'}</Tag>}>
            <MarkdownComponents>{item.expected_answer || '无参考答案'}</MarkdownComponents>
          </Card>
          <Card size="small" title="实际答案" extra={<Tag>{item.error_message ? '执行异常' : item.actual_refused ? '已拒答' : '已作答'}</Tag>}>
            <MarkdownComponents>{item.actual_answer || '无回答'}</MarkdownComponents>
          </Card>
        </div>
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} title="样本指标" items={[
          ...RAGAS_METRICS.map(({ key, name }) => ({ key, label: name, children: formatRate(item[key]) })),
          { key: 'citation', label: '引用命中', children: item.citation_hit == null ? '—' : item.citation_hit ? '命中' : '未命中' },
          { key: 'refusal', label: '拒答判断', children: item.error_message ? '—' : item.refusal_correct ? '正确' : '错误' },
          { key: 'latency', label: '总耗时', children: formatLatency(item.latency_ms) },
          { key: 'firstToken', label: '首 Token 耗时', children: formatLatency(item.first_token_latency_ms) },
        ]} />
        <Descriptions size="small" column={1} title="检索与验证" items={[
          { key: 'docs', label: '预期文档', children: item.expected_document_names?.join('、') || '—' },
          { key: 'keywords', label: '预期关键词', children: item.expected_keywords?.join('、') || '—' },
          { key: 'route', label: '查询策略', children: formatQueryStrategy(route?.route) },
          { key: 'query', label: '检索查询', children: readText(route?.query) || '—' },
          ...(route?.rewritten_query ? [{ key: 'rewrite', label: '改写后的查询', children: readText(route.rewritten_query) }] : []),
          ...(multiQueries.length ? [{ key: 'queries', label: '扩展查询',
            children: <ul>{multiQueries.map((value, index) => <li key={index}>{value}</li>)}</ul> }] : []),
          ...(route?.hyde_answer ? [{ key: 'hyde', label: 'HyDE 假设答案', children: readText(route.hyde_answer) }] : []),
          { key: 'verify', label: '答案验证', children: typeof verified === 'boolean'
            ? <Tag color={verified ? 'success' : 'error'}>{verified ? '通过' : '未通过'}</Tag> : '—' },
          { key: 'reason', label: '验证说明', children: readText(item.verify_result?.reason) || '—' },
          { key: 'trace', label: 'Trace ID', children: item.trace_id
            ? <Typography.Text className="evaluation-trace-id" copyable>{item.trace_id}</Typography.Text> : '—' },
          { key: 'created', label: '记录时间', children: formatDate(item.created_at) },
        ]} />
        <Collapse items={[
          { key: 'citations', label: `引用证据 · ${item.citations?.length ?? 0}`,
            children: <EvidenceList entries={item.citations ?? []} textField="quote" /> },
          { key: 'chunks', label: `检索片段 · ${item.retrieved_chunks_meta?.length ?? 0}`,
            children: <EvidenceList entries={item.retrieved_chunks_meta ?? []} textField="content" /> },
          { key: 'trace', label: '查询路由与检索轨迹',
            children: <pre className="evaluation-json">{JSON.stringify({
              query_route: item.query_route, agent_steps: item.agent_steps, verify_result: item.verify_result,
            }, null, 2)}</pre> },
        ]} />
        <Card size="small" title="Bad Case 归因">
          {status === 'running' ? <p className="evaluation-muted">评测结束后可编辑归因。</p> :
            !query.data || query.isPlaceholderData ? <p className="evaluation-muted">正在读取最新归因…</p> :
              <AttributionForm key={status} item={item} status={status} />}
        </Card>
      </div>
    </Drawer>
  )
}
