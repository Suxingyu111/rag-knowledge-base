import type { BadCaseCategory } from '@/api/evaluation'
import type { EvaluationRunRead } from '@/client'

export const BAD_CASE_CATEGORY_LABELS: Record<BadCaseCategory, string> = {
  document_parse_failed: '文档解析失败',
  chunk_split_bad: 'chunk 切分不合理',
  embedding_recall_miss: 'embedding 召回失败',
  keyword_recall_miss: '关键词召回缺失',
  rrf_fusion_error: 'RRF 融合异常',
  rerank_order_error: 'rerank 排序错误',
  context_judge_too_loose: '上下文判断过松',
  context_judge_too_strict: '上下文判断过严',
  prompt_constraint_weak: 'Prompt 约束不足',
  generation_off_context: '模型生成偏离上下文',
  citation_parse_failed: '引用解析失败',
  permission_filter_error: '权限过滤错误',
  other: '其他',
}

export const RAGAS_METRICS = [
  { key: 'faithfulness', name: '答案忠实度', description: '回答是否有检索内容支撑' },
  { key: 'answer_relevancy', name: '答案相关性', description: '回答是否切合问题' },
  { key: 'context_precision', name: '上下文精确率', description: '相关片段是否排在前面' },
  { key: 'context_recall', name: '上下文召回率', description: '是否检索到参考答案所需依据' },
] as const

export const RUN_METRICS = [
  ...RAGAS_METRICS,
  { key: 'citation_hit_rate', name: '引用命中率', description: '排除预期拒答的样本' },
  { key: 'refusal_accuracy', name: '拒答正确率', description: '实际是否拒答与预期一致' },
  { key: 'avg_latency_ms', name: '平均总耗时', description: '完成单条问答的平均耗时' },
  { key: 'avg_first_token_latency_ms', name: '平均首 Token 耗时', description: '仅统计记录首 Token 的样本' },
] as const

export const RUN_STATUS: Record<EvaluationRunRead['status'], { text: string; color: string }> = {
  running: { text: '运行中', color: 'processing' },
  completed: { text: '已完成', color: 'success' },
  failed: { text: '失败', color: 'error' },
}

const queryStrategies: Record<string, string> = {
  original: '原始问题', rewrite: '问题改写', hyde: 'HyDE', multi_query: '多查询',
}

export function formatQueryStrategy(route: unknown) {
  if (typeof route !== 'string' || !route) return '—'
  return Object.hasOwn(queryStrategies, route) ? queryStrategies[route] : route
}

export const POLL_INTERVAL = 3000

export function formatRate(value?: number | null) {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`
}

export function formatLatency(value?: number | null) {
  if (value == null) return '—'
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`
  return `${Math.round(value)} ms`
}

const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' })

export function formatDate(value?: string | null) {
  return value ? dateTime.format(new Date(value)) : '—'
}
