import { Alert, Button, Progress, Select, Tag } from 'antd'
import type { SelectProps } from 'antd'

import type { BadCaseCategory } from '@/api/evaluation'
import type { EvaluationRunListItem } from '@/client'
import { BAD_CASE_CATEGORY_LABELS, RUN_STATUS } from './evaluationPresentation'

const categoryOptions = Object.entries(BAD_CASE_CATEGORY_LABELS).map(([value, label]) => ({
  value: value as BadCaseCategory, label,
}))

export function BadCaseCategorySelect(props: SelectProps<BadCaseCategory>) {
  return <Select aria-label="Bad Case 归因" options={categoryOptions} virtual={false} {...props} />
}

export function RunStatusTag({ status }: { status: EvaluationRunListItem['status'] }) {
  const { text, color } = RUN_STATUS[status]
  return <Tag color={color}>{text}</Tag>
}

export function RunProgress({ run }: { run: EvaluationRunListItem }) {
  const { progress_completed: processed, progress_total: total, progress_failed: failed } = run
  const percent = total > 0 ? Math.min(100, Math.round(processed / total * 100)) : 0
  return (
    <div className="evaluation-progress">
      <Progress
        aria-label="样本处理进度"
        percent={percent}
        showInfo={false}
        size="small"
        status={run.status === 'failed' ? 'exception' : run.status === 'running' ? 'active' : 'normal'}
      />
      <span>已处理 {processed} / {total}{failed > 0 && <span className="evaluation-error-count"> · 异常 {failed}</span>}</span>
    </div>
  )
}

export function EvaluationRequestError({ error, retry }: { error: Error; retry: () => void }) {
  return <Alert type="error" showIcon title={error.message} action={<Button onClick={retry}>重试</Button>} />
}
