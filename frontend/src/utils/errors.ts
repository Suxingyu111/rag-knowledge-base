/**
 * 全局 HTTP 客户端错误处理。
 *
 * 后端所有错误响应统一为 `{ code, message, details }`（见
 * `backend/app/api/error_handlers.py`），这里把该结构、网络异常、超时和
 * 主动取消统一归一化为 {@link ApiError}，并挂到 `@hey-api/openapi-ts`
 * 生成的全局 client 上。业务代码统一从 `src/api/client.ts` 调用接口，
 * 无需在每个请求里重复 try/catch 和弹提示。
 *
 * 使用方式：
 *
 * ```ts
 * // main.tsx：导入统一请求入口即可完成安装（只需要执行一次）
 * import './api/client'
 *
 * // BasicLayout.tsx：把 antd 的 message 实例绑定进来，提示才能跟随主题与全局配置
 * const { message } = AntApp.useApp()
 * useEffect(() => setErrorNotifier(message), [message])
 * ```
 *
 * 单独使用：
 *
 * ```ts
 * import { api, ApiError } from './api/client'
 *
 * try {
 *   const health = await api.health.check()
 * } catch (error) {
 *   // 拦截器已经弹过提示，这里只做业务兜底
 *   if (error instanceof ApiError) {
 *     // ...
 *   }
 * }
 *
 * // 手动处理非 client 抛出的错误
 * handleApiError(error, { silent: true })
 * ```
 *
 * 不需要提示的请求（轮询、后台预取等）在调用统一入口时传入
 * `silent: true` 即可跳过弹窗，错误对象仍会被归一化。
 */
import { message as antdMessage } from 'antd'

import { client } from '../client/client.gen'
import type { Client } from '../client/client'

/** 未知错误的兜底文案。 */
const UNKNOWN_ERROR_MESSAGE = '请求失败，请稍后重试'
/** 网络不可用时的提示。 */
const NETWORK_ERROR_MESSAGE = '无法连接服务器，请检查网络后重试'
/** 请求超时时的提示。 */
const TIMEOUT_ERROR_MESSAGE = '请求超时，请稍后重试'
/** 请求被主动取消时的提示（默认不展示）。 */
const CANCELED_ERROR_MESSAGE = '请求已取消'

/** 相同错误在该时间窗口内只提示一次，避免并发请求刷屏。 */
const DEFAULT_DEDUPE_WINDOW_MS = 3000
/** 错误提示停留时长。 */
const ERROR_TOAST_DURATION = 4

/**
 * 常见 HTTP 状态码对应的中文兜底文案。
 *
 * 优先使用后端返回的 `message`，只有缺失时才回退到这里，以保持与后端
 * `error_handlers.py` 中的文案一致。
 */
const STATUS_MESSAGE_MAP: Record<number, string> = {
  400: '请求参数错误',
  401: '未登录或登录已失效',
  403: '无权访问该资源',
  404: '请求的资源不存在',
  405: '请求方法不被允许',
  406: '服务器无法处理该请求',
  408: '请求超时，请稍后重试',
  409: '资源冲突',
  413: '上传内容过大',
  415: '不支持的内容类型',
  422: '请求参数校验失败',
  429: '请求过于频繁，请稍后再试',
  500: '服务内部错误',
  501: '服务暂未实现该功能',
  502: '服务网关异常，请稍后重试',
  503: '服务暂时不可用，请稍后重试',
  504: '服务响应超时，请稍后重试',
}

/** 状态码到业务 code 的兜底映射，与后端保持一致。 */
const STATUS_CODE_MAP: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'permission_denied',
  404: 'not_found',
  405: 'method_not_allowed',
  408: 'request_timeout',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable_entity',
  429: 'too_many_requests',
  500: 'internal_error',
  501: 'not_implemented',
  502: 'bad_gateway',
  503: 'service_unavailable',
  504: 'gateway_timeout',
}

/**
 * 框架或网关返回的标准英文短语。它们对用户没有意义，命中后改用中文兜底。
 */
const STANDARD_HTTP_PHRASES = new Set([
  'Bad Request',
  'Unauthorized',
  'Forbidden',
  'Not Found',
  'Method Not Allowed',
  'Not Acceptable',
  'Conflict',
  'Unprocessable Entity',
  'Too Many Requests',
  'Internal Server Error',
  'Not Implemented',
  'Bad Gateway',
  'Service Unavailable',
  'Gateway Timeout',
])

/** 不应直接展示给用户的技术性错误文案。 */
const TECHNICAL_MESSAGE_PATTERN =
  /^(Unexpected token|JSON\.parse|NetworkError|Failed to fetch|Load failed|fetch failed|Network request failed)/i

/** 请求上下文，由 client 拦截器传入，也可手动传入。 */
export interface ApiErrorContext {
  response?: Response
  request?: Request
  options?: {
    method?: string
    url?: string
    meta?: unknown
  }
}

/** {@link ApiError} 的构造参数。 */
export interface ApiErrorOptions {
  /** HTTP 状态码；网络异常或取消时为 undefined。 */
  status?: number
  /** 稳定的业务错误码，例如 `not_found`。 */
  code?: string
  /** 后端返回的补充明细（422 时为逐字段校验信息）。 */
  details?: unknown
  /** 服务端请求 ID，便于排查问题。 */
  requestId?: string | null
  /** 请求方法，例如 `GET`。 */
  method?: string
  /** 请求地址。 */
  url?: string
  /** 是否为网络层错误（断网、DNS、CORS 等）。 */
  isNetworkError?: boolean
  /** 是否超时。 */
  isTimeout?: boolean
  /** 是否被 `AbortSignal` 主动取消。 */
  isCanceled?: boolean
  /** 是否建议重试。 */
  retryable?: boolean
  /** 原始错误，保留在 `cause` 上方便排查。 */
  cause?: unknown
}

/**
 * 统一的 API 错误对象。
 *
 * 无论错误来自后端响应、网络异常还是手动抛出，调用方都可以用同一套字段
 * 判断和处理，例如 `error.status === 401`、`error.retryable`。
 */
export class ApiError extends Error {
  readonly status: number | undefined
  readonly code: string
  readonly details: unknown
  readonly requestId: string | null
  readonly method: string | undefined
  readonly url: string | undefined
  readonly isNetworkError: boolean
  readonly isTimeout: boolean
  readonly isCanceled: boolean
  readonly retryable: boolean

  constructor(message: string, options: ApiErrorOptions = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'ApiError'
    this.status = options.status
    this.code = options.code ?? 'unknown_error'
    this.details = options.details
    this.requestId = options.requestId ?? null
    this.method = options.method
    this.url = options.url
    this.isNetworkError = options.isNetworkError ?? false
    this.isTimeout = options.isTimeout ?? false
    this.isCanceled = options.isCanceled ?? false
    this.retryable = options.retryable ?? false
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      details: this.details,
      requestId: this.requestId,
      method: this.method,
      url: this.url,
      isNetworkError: this.isNetworkError,
      isTimeout: this.isTimeout,
      isCanceled: this.isCanceled,
      retryable: this.retryable,
    }
  }
}

/** 判断一个值是否为 {@link ApiError}。 */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

/** antd message 实例所需的最小接口，便于测试或替换实现。 */
export interface ErrorNotifier {
  error: (config: {
    content: string
    key?: string | number
    duration?: number
  }) => unknown
}

let activeNotifier: ErrorNotifier | null = null
let dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS
let onErrorHook: ((error: ApiError, context: ApiErrorContext) => void) | null =
  null

/**
 * 绑定 antd 的 message 实例（推荐在 `<App>` 内部用 `App.useApp()` 获取）。
 *
 * 返回解绑函数，可直接作为 `useEffect` 的清理函数：
 * `useEffect(() => setErrorNotifier(message), [message])`。
 */
export function setErrorNotifier(notifier: ErrorNotifier | null): () => void {
  activeNotifier = notifier
  return () => {
    if (activeNotifier === notifier) {
      activeNotifier = null
    }
  }
}

/** 全局错误处理的额外配置。 */
export interface HttpErrorHandlingConfig {
  /** 相同错误的去重时间窗口，单位毫秒，默认 3000。 */
  dedupeWindowMs?: number
  /**
   * 错误归一化后的统一回调，可用于上报监控或处理 401 跳转登录。
   * 返回的 {@link ApiError} 仍会照常展示提示（除非请求标记为 silent）。
   */
  onError?: ((error: ApiError, context: ApiErrorContext) => void) | null
}

/** 配置全局错误处理行为，可在应用启动时调用一次。 */
export function configureHttpErrorHandling(
  config: HttpErrorHandlingConfig,
): void {
  if (config.dedupeWindowMs !== undefined && config.dedupeWindowMs >= 0) {
    dedupeWindowMs = config.dedupeWindowMs
  }
  if (config.onError !== undefined) {
    onErrorHook = config.onError
  }
}

/** 默认提示实现，未绑定 antd 实例时也能工作（但不会跟随 ConfigProvider 主题）。 */
const staticNotifier: ErrorNotifier = {
  error: (config) => antdMessage.error(config),
}

/** 最近展示过的提示，key 为「状态码 + 业务码 + 文案」。 */
const recentToasts = new Map<string, number>()

function shouldNotify(key: string): boolean {
  const now = Date.now()
  const last = recentToasts.get(key)

  if (last !== undefined && now - last < dedupeWindowMs) {
    return false
  }

  recentToasts.set(key, now)

  if (recentToasts.size > 50) {
    for (const [itemKey, timestamp] of recentToasts) {
      if (now - timestamp >= dedupeWindowMs) {
        recentToasts.delete(itemKey)
      }
    }
  }

  return true
}

/**
 * 展示统一错误提示。
 *
 * 主动取消的请求不会提示；相同错误在去重窗口内只提示一次。
 */
export function showErrorToast(error: ApiError): void {
  if (error.isCanceled) {
    return
  }

  const key = `http-error:${error.status ?? 0}:${error.code}:${error.message}`
  if (!shouldNotify(key)) {
    return
  }

  const notifier = activeNotifier ?? staticNotifier

  try {
    notifier.error({
      content: error.message,
      key,
      duration: ERROR_TOAST_DURATION,
    })
  } catch (cause) {
    // 提示本身失败不应影响请求流程
    recentToasts.delete(key)
    console.error('[http] 错误提示展示失败', cause)
  }
}

function dispatchError(
  error: ApiError,
  context: ApiErrorContext,
  silent: boolean,
): void {
  if (error.isCanceled) {
    return
  }

  if (onErrorHook) {
    try {
      onErrorHook(error, context)
    } catch (cause) {
      console.error('[http] onError 回调执行失败', cause)
    }
  }

  if (!silent) {
    showErrorToast(error)
  }
}

/** 判断 SDK 的 `meta` 是否要求跳过全局提示。 */
export function isSilentRequest(meta: unknown): boolean {
  return (
    isRecord(meta) && (meta.silent === true || meta.skipErrorToast === true)
  )
}

/**
 * 归一化并处理任意错误：转换成 {@link ApiError}、触发 `onError`、
 * 按需展示提示。适合在拦截器之外手动处理错误。
 */
export function handleApiError(
  error: unknown,
  options: { silent?: boolean; context?: ApiErrorContext } = {},
): ApiError {
  const context = options.context ?? {}
  const normalized = normalizeApiError(error, context)
  dispatchError(normalized, context, options.silent ?? false)
  return normalized
}

/**
 * 把任意错误归一化为 {@link ApiError}。
 *
 * 支持：
 * - 后端统一错误体 `{ code, message, details }`；
 * - FastAPI 原始校验错误 `{ detail: [...] }`；
 * - 纯文本错误体；
 * - `fetch` 网络异常、`AbortSignal` 取消、超时。
 */
export function normalizeApiError(
  error: unknown,
  context: ApiErrorContext = {},
): ApiError {
  if (error instanceof ApiError) {
    return error
  }

  const response = context.response
  const status = resolveStatus(error, response)
  const payload = unwrapPayload(error)
  const canceled = isAbortError(error)
  const timeout = !canceled && isTimeoutError(error)
  const network =
    !canceled && !timeout && status === undefined && isNetworkError(error)
  const code = resolveCode(payload, status, { canceled, timeout, network })
  const details = resolveDetails(payload)
  const requestId = resolveRequestId(payload, response)
  const rawMessage = resolveRawMessage(payload)
  const message = resolveUserMessage({
    rawMessage,
    status,
    canceled,
    timeout,
    network,
    error,
  })

  const request = context.request
  const requestOptions = context.options

  return new ApiError(message, {
    status,
    code,
    details,
    requestId,
    method: requestOptions?.method ?? request?.method,
    url: requestOptions?.url ?? request?.url,
    isNetworkError: network,
    isTimeout: timeout,
    isCanceled: canceled,
    retryable:
      !canceled &&
      (network ||
        timeout ||
        status === 408 ||
        status === 429 ||
        (status !== undefined && status >= 500)),
    cause: error,
  })
}

const installedClients = new WeakSet<Client>()

/**
 * 安装全局错误拦截器。
 *
 * 拦截器会把错误归一化为 {@link ApiError} 后继续返回给调用方：
 * - `throwOnError: true` 时抛出 `ApiError`；
 * - 默认返回 `{ error: ApiError }`，调用方可直接读取。
 *
 * 同一个 client 重复安装不会产生重复提示。返回的函数用于卸载拦截器。
 */
export function installHttpErrorHandler(target: Client = client): () => void {
  if (installedClients.has(target)) {
    return () => {}
  }

  const interceptorId = target.interceptors.error.use(
    (error, response, request, options) => {
      const context: ApiErrorContext = { response, request, options }
      const normalized = normalizeApiError(error, context)
      const silent = isSilentRequest(
        (options as unknown as { meta?: unknown }).meta,
      )
      dispatchError(normalized, context, silent)
      return normalized
    },
  )

  installedClients.add(target)

  return () => {
    target.interceptors.error.eject(interceptorId)
    installedClients.delete(target)
  }
}

/**
 * 已接入统一错误处理的全局 HTTP 客户端。
 *
 * `src/client/sdk.gen.ts` 中的方法都共享这个实例，业务侧无需另建客户端。
 */
export { client as httpClient }

function resolveStatus(
  error: unknown,
  response?: Response,
): number | undefined {
  // 只有 >= 400 的响应才是错误响应；2xx 解析失败等场景不能误判状态码
  if (response && response.status >= 400) {
    return response.status
  }

  if (isRecord(error)) {
    for (const key of ['status', 'statusCode', 'status_code'] as const) {
      const value = error[key]
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 400
      ) {
        return value
      }
    }
  }

  return undefined
}

function unwrapPayload(
  error: unknown,
): Record<string, unknown> | string | undefined {
  if (typeof error === 'string') {
    return error
  }

  if (!isRecord(error)) {
    return undefined
  }

  // 兼容 react-query 等场景下再包一层的 `{ error: body }`
  const nested = error.error
  if (
    isRecord(nested) &&
    ('message' in nested || 'detail' in nested || 'code' in nested)
  ) {
    return nested
  }

  return error
}

function resolveCode(
  payload: Record<string, unknown> | string | undefined,
  status: number | undefined,
  flags: { canceled: boolean; timeout: boolean; network: boolean },
): string {
  if (flags.canceled) {
    return 'request_canceled'
  }
  if (flags.timeout) {
    return 'request_timeout'
  }
  if (flags.network) {
    return 'network_error'
  }

  if (isRecord(payload)) {
    const code = readString(payload, ['code', 'error_code'])
    if (code) {
      return code
    }
  }

  if (status !== undefined) {
    return STATUS_CODE_MAP[status] ?? `http_${status}`
  }

  return 'unknown_error'
}

function resolveDetails(
  payload: Record<string, unknown> | string | undefined,
): unknown {
  if (!isRecord(payload)) {
    return undefined
  }

  for (const key of ['details', 'detail', 'errors'] as const) {
    if (key in payload) {
      return payload[key]
    }
  }

  return undefined
}

function resolveRequestId(
  payload: Record<string, unknown> | string | undefined,
  response?: Response,
): string | null {
  if (isRecord(payload)) {
    const requestId = readString(payload, [
      'request_id',
      'requestId',
      'trace_id',
      'traceId',
    ])
    if (requestId) {
      return requestId
    }
  }

  if (response) {
    for (const header of [
      'x-request-id',
      'x-trace-id',
      'x-correlation-id',
    ]) {
      const value = response.headers.get(header)
      if (value) {
        return value
      }
    }
  }

  return null
}

function resolveRawMessage(
  payload: Record<string, unknown> | string | undefined,
): string | undefined {
  if (typeof payload === 'string') {
    return payload
  }

  if (!isRecord(payload)) {
    return undefined
  }

  return readString(payload, ['message', 'detail', 'error', 'msg'])
}

function resolveUserMessage(input: {
  rawMessage: string | undefined
  status: number | undefined
  canceled: boolean
  timeout: boolean
  network: boolean
  error: unknown
}): string {
  if (input.canceled) {
    return CANCELED_ERROR_MESSAGE
  }
  if (input.timeout) {
    return TIMEOUT_ERROR_MESSAGE
  }
  if (input.network) {
    return NETWORK_ERROR_MESSAGE
  }

  const fallback =
    input.status === undefined
      ? UNKNOWN_ERROR_MESSAGE
      : (STATUS_MESSAGE_MAP[input.status] ?? `请求失败（HTTP ${input.status}）`)

  const raw = input.rawMessage && normalizeMessage(input.rawMessage)
  if (
    raw &&
    !STANDARD_HTTP_PHRASES.has(raw) &&
    !TECHNICAL_MESSAGE_PATTERN.test(raw)
  ) {
    return raw
  }

  // 原生 Error 的消息可能比后端文案更具体（例如业务层主动抛错）
  if (input.error instanceof Error && input.status === undefined) {
    const message = normalizeMessage(input.error.message)
    if (
      message &&
      !STANDARD_HTTP_PHRASES.has(message) &&
      !TECHNICAL_MESSAGE_PATTERN.test(message)
    ) {
      return message
    }
  }

  return fallback
}

function normalizeMessage(message: string): string | undefined {
  const normalized = message.replace(/\s+/g, ' ').trim()

  // HTML 错误页或超长堆栈不适合直接展示
  if (!normalized || normalized.startsWith('<') || normalized.length > 160) {
    return undefined
  }

  return normalized
}

function readString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAbortError(error: unknown): boolean {
  return readErrorName(error) === 'AbortError'
}

function isTimeoutError(error: unknown): boolean {
  const name = readErrorName(error)

  if (name === 'TimeoutError') {
    return true
  }

  return (
    isRecord(error) &&
    (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED')
  )
}

function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''

  // 浏览器与 Node 的 fetch 失败文案各不相同，统一按关键字识别
  return /fetch|network|load failed|econnrefused|enotfound|econnreset|socket hang up/i.test(
    message,
  )
}

function readErrorName(error: unknown): string | undefined {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name
  }

  if (isRecord(error) && typeof error.name === 'string') {
    return error.name
  }

  return undefined
}
