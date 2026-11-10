import { Tag } from 'antd'

import type { AgentStep } from '@/client/types.gen'

const actions = {
  initial: { color: 'default', label: '初始检索' },
  proceed: { color: 'green', label: '继续生成' },
  rewrite_query: { color: 'blue', label: '改写 Query' },
  switch_route: { color: 'purple', label: '切换策略' },
  refuse: { color: 'red', label: '提前拒答' },
} satisfies Record<AgentStep['action'], { color: string; label: string }>

export default function AgentRetrievalDetails({ steps }: { steps?: AgentStep[] | null }) {
  if (!steps?.length) return null

  return (
    <details style={{ marginBlockEnd: 12, overflowWrap: 'anywhere' }}>
      <summary>检索决策过程 · {steps.length} 条记录</summary>
      <ol>
        {steps.map((step, index) => {
          const { color, label } = actions[step.action]
          return (
            <li key={index}>
              <span>第 {step.round} 轮 </span>
              <Tag color={color}>{label}</Tag>
              <span>策略 {step.route}</span>
              <div>查询：{step.query}</div>
              {step.reason && <div>决策摘要：{step.reason}</div>}
              {step.retrieved_count != null && <div>召回 {step.retrieved_count} 条</div>}
              {step.top_score != null && <div>最高分 {step.top_score.toFixed(3)}</div>}
              {step.sufficient != null && <div>{step.sufficient ? '证据充足' : '证据不足'}</div>}
            </li>
          )
        })}
      </ol>
    </details>
  )
}
