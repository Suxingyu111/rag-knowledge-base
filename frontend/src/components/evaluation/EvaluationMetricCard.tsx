import { Card, Tooltip } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'

export default function EvaluationMetricCard({ name, value, description }: {
  name: string
  value: string
  description: string
}) {
  return (
    <Card className="evaluation-metric" size="small">
      <div className="evaluation-metric-label">{name} <Tooltip title={description}><InfoCircleOutlined tabIndex={0} /></Tooltip></div>
      <div className="evaluation-metric-value">{value}</div>
    </Card>
  )
}
