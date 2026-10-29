import {
  ApiOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { Button } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { api, handleApiError, isApiError } from '../api/client'
import './HomePages.css'

/* --------------------------------------------------------------------------
   Types
-------------------------------------------------------------------------- */

type HealthKey = 'service' | 'database' | 'cos'

type HealthStatus = 'checking' | 'healthy' | 'unhealthy'

/** 一次探针执行完成后的结果，同时适用于成功与失败。 */
interface HealthSnapshot {
  status: Exclude<HealthStatus, 'checking'>
  message: string
  latencyMs: number
  /** 服务端耗时（数据库 / COS）或前端测得的往返耗时。 */
  latencySource: 'server' | 'client'
  checkedAt: string
  code?: string
}

/** 卡片状态：首次加载或重试期间为 `checking`，随后为具体检查结果。 */
type HealthCheckState = { status: 'checking' } | HealthSnapshot

/** 探针函数，接收取消信号，内部不会抛错。 */
type HealthProbe = (signal: AbortSignal) => Promise<HealthSnapshot>

/** 从接口响应中提取卡片所需的展示字段。 */
interface HealthReading {
  message: string
  latencyMs?: number
  checkedAt?: string
}

interface HealthCheckDefinition {
  key: HealthKey
  eyebrow: string
  title: string
  description: string
  endpoint: string
  note: string
  icon: ReactNode
  probe: HealthProbe
}

interface HealthSummary {
  status: HealthStatus
  label: string
  detail: string
}

/* --------------------------------------------------------------------------
   Helpers
-------------------------------------------------------------------------- */

const CLOCK_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const FULL_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const STATUS_LABELS: Record<HealthStatus, string> = {
  checking: '检测中',
  healthy: '运行正常',
  unhealthy: '不可用',
}

/** 当前毫秒时间戳，统一封装便于测试替换。 */
function now(): number {
  return performance.now()
}

/** 计算从 `startedAt` 到现在的耗时，避免出现负数。 */
function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(now() - startedAt))
}

/** 把 ISO 时间格式化为 `HH:mm:ss`，无效时间返回占位文案。 */
function formatClockTime(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return '未知'
  }

  return CLOCK_FORMATTER.format(date)
}

/** 用于 `title` 的完整日期时间，方便悬停核对。 */
function formatFullTime(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return '未知时间'
  }

  return FULL_TIME_FORMATTER.format(date)
}

/** 把毫秒数格式化为带单位的耗时，超过 1 秒时保留两位小数。 */
function formatLatency(latencyMs: number): string {
  if (!Number.isFinite(latencyMs)) {
    return '未知'
  }

  if (latencyMs < 1000) {
    return `${Math.round(latencyMs)} ms`
  }

  return `${(latencyMs / 1000).toFixed(2)} s`
}

/** 合并三个探针的结果，生成右上角总览文案。 */
function summarizeChecks(
  states: readonly HealthCheckState[],
): HealthSummary {
  const total = states.length
  const checking = states.filter((state) => state.status === 'checking').length
  const healthy = states.filter((state) => state.status === 'healthy').length
  const unhealthy = total - healthy - checking

  if (checking > 0) {
    return {
      status: 'checking',
      label: STATUS_LABELS.checking,
      detail: `${total - checking} / ${total} 已完成`,
    }
  }

  if (unhealthy === 0) {
    return {
      status: 'healthy',
      label: '全部正常',
      detail: `${total} 项检查全部通过`,
    }
  }

  return {
    status: 'unhealthy',
    label: '需要关注',
    detail: `${unhealthy} 项检查未通过`,
  }
}

/** 取所有已完成探针中最新的检测时间。 */
function latestCheckedAt(
  states: readonly HealthCheckState[],
): string | undefined {
  let latestTime = Number.NEGATIVE_INFINITY
  let latestValue: string | undefined

  for (const state of states) {
    if (state.status === 'checking') {
      continue
    }

    const time = Date.parse(state.checkedAt)
    if (Number.isFinite(time) && time > latestTime) {
      latestTime = time
      latestValue = state.checkedAt
    }
  }

  return latestValue
}

/**
 * 执行一次探针并归一化结果。
 *
 * 失败时不向外抛错，而是转换成 `unhealthy` 快照，让卡片可以就地展示
 * 后端返回的错误文案与错误码。请求本身已由 `api/client` 归一化为
 * `ApiError`，这里再兜底处理非预期异常。
 */
async function runHealthCheck<T>(
  load: () => Promise<T>,
  read: (data: T) => HealthReading,
): Promise<HealthSnapshot> {
  const startedAt = now()

  try {
    const data = await load()
    const reading = read(data)
    const serverLatency = reading.latencyMs

    return {
      status: 'healthy',
      message: reading.message,
      latencyMs: serverLatency ?? elapsedSince(startedAt),
      latencySource: serverLatency === undefined ? 'client' : 'server',
      checkedAt: reading.checkedAt ?? new Date().toISOString(),
    }
  } catch (error) {
    const apiError = isApiError(error)
      ? error
      : handleApiError(error, { silent: true })

    return {
      status: 'unhealthy',
      message: apiError.message,
      latencyMs: elapsedSince(startedAt),
      latencySource: 'client',
      checkedAt: new Date().toISOString(),
      code: apiError.code,
    }
  }
}

/**
 * 管理单个探针的加载、成功、失败与重试状态。
 *
 * 组件卸载或重复触发时会中止上一个请求，避免旧结果覆盖新结果。
 */
function useHealthCheck(probe: HealthProbe) {
  const [state, setState] = useState<HealthCheckState>({
    status: 'checking',
  })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()

    void probe(controller.signal)
      .then((snapshot) => {
        if (!controller.signal.aborted) {
          setState(snapshot)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({
            status: 'unhealthy',
            message: '检查失败，请稍后重试',
            latencyMs: 0,
            latencySource: 'client',
            checkedAt: new Date().toISOString(),
            code: 'unknown_error',
          })
        }
      })

    return () => controller.abort()
  }, [attempt, probe])

  const refresh = useCallback(() => {
    setState({ status: 'checking' })
    setAttempt((value) => value + 1)
  }, [])

  return { state, refresh }
}

/**
 * 三个探针的展示配置。
 *
 * `probe` 在模块作用域内定义，引用稳定，`useHealthCheck` 的 effect 不会
 * 因为组件重新渲染而重复发起请求。
 */
const HEALTH_CHECKS: readonly HealthCheckDefinition[] = [
  {
    key: 'service',
    eyebrow: 'LIVENESS / 01',
    title: '后端服务',
    description: 'FastAPI 进程存活，能够正常处理请求。',
    endpoint: '/api/health',
    note: '存活探针 · 不访问外部依赖',
    icon: <ApiOutlined />,
    probe: (signal) =>
      runHealthCheck(
        () => api.health.check({ signal, silent: true }),
        (data) => ({
          message: data.message,
          checkedAt: data.timestamp,
        }),
      ),
  },
  {
    key: 'database',
    eyebrow: 'DATABASE / 02',
    title: 'PostgreSQL',
    description: '执行 SELECT 1，确认连接串、网络与实例可用。',
    endpoint: '/api/health/database',
    note: '就绪探针 · 依赖数据库',
    icon: <DatabaseOutlined />,
    probe: (signal) =>
      runHealthCheck(
        () => api.health.checkDatabase({ signal, silent: true }),
        (data) => ({
          message: data.message,
          latencyMs: data.latency_ms,
          checkedAt: data.timestamp,
        }),
      ),
  },
  {
    key: 'cos',
    eyebrow: 'STORAGE / 03',
    title: '对象存储 COS',
    description: '调用 ListObjects，验证配置、鉴权与存储桶连通。',
    endpoint: '/api/health/cos',
    note: '就绪探针 · 依赖对象存储',
    icon: <CloudServerOutlined />,
    probe: (signal) =>
      runHealthCheck(
        () => api.health.checkCos({ signal, silent: true }),
        (data) => ({
          message: data.message,
          latencyMs: data.latency_ms,
          checkedAt: data.timestamp,
        }),
      ),
  },
]

/* --------------------------------------------------------------------------
   CheckCard
-------------------------------------------------------------------------- */

interface CheckCardProps {
  definition: HealthCheckDefinition
  index: number
  state: HealthCheckState
  onRetry: () => void
}

/**
 * 单个健康检查卡片。
 *
 * 只负责展示，不发起请求；请求状态由 `useHealthCheck` 提供，便于复用和
 * 单独测试。加载时用骨架占位，失败时就地展示错误文案、错误码与重试入口。
 */
function CheckCard({ definition, index, state, onRetry }: CheckCardProps) {
  const titleId = `health-card-${definition.key}-title`
  const isChecking = state.status === 'checking'

  return (
    <article
      aria-busy={isChecking}
      aria-labelledby={titleId}
      className={`hp-card is-${state.status}`}
    >
      <div className="hp-card-top">
        <span className="hp-card-index">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span className="hp-status">
          <span aria-hidden="true" className="hp-status-dot" />
          {STATUS_LABELS[state.status]}
        </span>
      </div>

      <div className="hp-card-body">
        <span aria-hidden="true" className="hp-card-icon">
          {definition.icon}
        </span>
        <div className="hp-card-copy">
          <span className="hp-card-eyebrow">{definition.eyebrow}</span>
          <h2 id={titleId}>{definition.title}</h2>
          <p>{definition.description}</p>
        </div>
      </div>

      <code className="hp-endpoint">
        <span>GET</span>
        {definition.endpoint}
      </code>

      <div className="hp-reading">
        {state.status === 'checking' ? (
          <>
            <span className="hp-visually-hidden">
              正在检查 {definition.title}
            </span>
            <span aria-hidden="true" className="hp-skeleton hp-skeleton--wide" />
            <span
              aria-hidden="true"
              className="hp-skeleton hp-skeleton--narrow"
            />
          </>
        ) : (
          <>
            <p className="hp-message">{state.message}</p>
            <div className="hp-meta">
              <span>
                <span className="hp-meta-label">
                  {state.latencySource === 'server' ? '服务端耗时' : '往返耗时'}
                </span>
                {formatLatency(state.latencyMs)}
              </span>
              <span>
                <span className="hp-meta-label">检测于</span>
                <time
                  dateTime={state.checkedAt}
                  title={formatFullTime(state.checkedAt)}
                >
                  {formatClockTime(state.checkedAt)}
                </time>
              </span>
            </div>
            {state.status === 'unhealthy' && state.code ? (
              <p className="hp-error-code">
                <span>错误码</span>
                <code>{state.code}</code>
              </p>
            ) : null}
          </>
        )}
      </div>

      <footer className="hp-card-foot">
        <span>{definition.note}</span>
        <Button
          aria-label={`重新检测 ${definition.title}`}
          className="hp-retry"
          icon={<ReloadOutlined />}
          loading={isChecking}
          onClick={onRetry}
          size="small"
          type="text"
        >
          重新检测
        </Button>
      </footer>
    </article>
  )
}

/* --------------------------------------------------------------------------
   HomePage
-------------------------------------------------------------------------- */

/**
 * 首页：并行展示后端服务、数据库与 COS 三个健康检查结果。
 *
 * 三个探针各自维护状态，单个失败不会阻塞其他卡片；右上角总览汇总
 * 点击「重新检测」会同时刷新三项检查。
 */
export function HomePage() {
  const { state: serviceState, refresh: refreshService } =
    useHealthCheck(HEALTH_CHECKS[0].probe)
  const { state: databaseState, refresh: refreshDatabase } =
    useHealthCheck(HEALTH_CHECKS[1].probe)
  const { state: cosState, refresh: refreshCos } = useHealthCheck(
    HEALTH_CHECKS[2].probe,
  )

  const states = [serviceState, databaseState, cosState]
  const summary = summarizeChecks(states)
  const checkedAt = latestCheckedAt(states)
  const isChecking = states.some((state) => state.status === 'checking')

  const refreshAll = useCallback(() => {
    refreshService()
    refreshDatabase()
    refreshCos()
  }, [refreshService, refreshDatabase, refreshCos])

  const cards = [
    {
      definition: HEALTH_CHECKS[0],
      state: serviceState,
      refresh: refreshService,
    },
    {
      definition: HEALTH_CHECKS[1],
      state: databaseState,
      refresh: refreshDatabase,
    },
    {
      definition: HEALTH_CHECKS[2],
      state: cosState,
      refresh: refreshCos,
    },
  ]

  return (
    <section className="kb-stage hp-stage" aria-labelledby="hp-page-title">
      <header className="hp-head">
        <div className="hp-head-copy">
          <p className="kb-kicker">
            <span aria-hidden="true" className="kb-kicker-rule" />
            SYSTEM HEALTH / 运行状态
          </p>
          <h1 id="hp-page-title">
            三个探针，
            <br />
            <em>确认系统在线。</em>
          </h1>
          <p className="kb-lede">
            从进程、数据库到对象存储，逐一确认依赖是否可用。任一探针失败时，卡片内会给出原因和错误码，其他检查继续完成。
          </p>
        </div>

        <aside
          aria-label="健康检查总览"
          className={`hp-overview is-${summary.status}`}
        >
          <span className="hp-overview-label">OVERALL</span>
          <strong className="hp-overview-status">
            <span aria-hidden="true" className="hp-status-dot" />
            {summary.label}
          </strong>
          <span className="hp-overview-detail">{summary.detail}</span>
          <span className="hp-overview-time">
            {checkedAt
              ? `最近更新 ${formatClockTime(checkedAt)}`
              : '等待首次结果'}
          </span>
          <Button
            className="hp-refresh"
            icon={<ReloadOutlined />}
            loading={isChecking}
            onClick={refreshAll}
            type="default"
          >
            重新检测
          </Button>
        </aside>
      </header>

      <p aria-live="polite" className="hp-visually-hidden" role="status">
        {summary.label}，{summary.detail}
      </p>

      <div className="hp-grid">
        {cards.map(({ definition, state, refresh }, index) => (
          <CheckCard
            definition={definition}
            index={index}
            key={definition.key}
            onRetry={refresh}
            state={state}
          />
        ))}
      </div>

      <footer className="kb-stage-note">
        <span className="kb-note-mark">HEALTH</span>
        <span>
          探针直接请求后端公开端点，不读取业务数据；接口返回 503 时卡片会标记为不可用。
        </span>
      </footer>
    </section>
  )
}

export default HomePage
