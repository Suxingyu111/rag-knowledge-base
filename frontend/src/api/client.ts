/**
 * 统一的后端请求入口。
 *
 * 本模块在 `@hey-api/openapi-ts` 生成的 client（`src/client`）之上做一层
 * 约定，业务代码只从这里导入接口，不要直接调用生成的 `sdk.gen.ts`：
 *
 * 1. **统一 baseURL**：默认同源，开发环境由 Vite 把 `/api` 代理到
 *    `http://localhost:8000`；部署到独立域名时通过 `VITE_API_BASE_URL`
 *    覆盖（不含结尾 `/`）。
 * 2. **统一超时**：默认 {@link DEFAULT_API_TIMEOUT_MS}，可通过 `timeoutMs`
 *    按请求覆盖，传 `0` 表示不限制（大文件上传等场景）。
 * 3. **统一错误**：复用 `src/utils/errors.ts` 的拦截器，把后端
 *    `{ code, message, details }`、网络异常、超时和取消统一归一化为
 *    {@link ApiError}，并默认弹出一次性提示；`silent: true` 可静默。
 * 4. **统一响应**：业务方法成功时直接返回响应体 `data`，失败时抛出
 *    {@link ApiError}，调用方不需要再判断 `{ data, error }`。
 *
 * @example
 * ```ts
 * import { api, ApiError } from '@/api/client'
 *
 * // 业务域方法：成功直接拿到 data
 * const health = await api.health.check()
 *
 * // 通用方法：路径不必写 `/api` 前缀
 * const page = await api.get<DocumentPage>('/documents', {
 *   query: { page: 1, page_size: 20 },
 * })
 *
 * // 静默请求：不弹全局错误提示
 * const cos = await api.health.checkCos({ silent: true })
 *
 * try {
 *   await api.post('/documents', payload)
 * } catch (error) {
 *   if (error instanceof ApiError && error.status === 409) {
 *     // 业务兜底；全局提示已经展示过，可按需处理
 *   }
 * }
 * ```
 *
 * 新增接口的流程：后端声明 `operation_id` → 执行 `npm run gen:api` →
 * 在下方新增对应业务域的包装方法，复用 {@link ApiCallOptions} 即可。
 */
import { client } from '../client/client.gen'
import {
  healthCheck,
  healthCheckCos,
  healthCheckDatabase,
} from '../client/sdk.gen'
import type {
  ComponentHealthResponse,
  HealthCheckResponse,
} from '../client/types.gen'
import {
  ApiError,
  handleApiError,
  installHttpErrorHandler,
  isApiError,
} from '../utils/errors'

/** 后端路由统一前缀，与 `backend/app/main.py` 中的 `/api` 保持一致。 */
const API_PREFIX = '/api'

/** 默认请求超时（毫秒）。 */
export const DEFAULT_API_TIMEOUT_MS = 30_000

/**
 * 后端 API 的基础地址。
 *
 * - 未设置 `VITE_API_BASE_URL` 时为空串，表示与前端同源：开发环境走 Vite
 *   的 `/api` 代理，生产环境适合同域部署（由网关或后端托管静态资源）。
 * - 独立域名部署时在 `frontend/.env` 中设置，例如
 *   `VITE_API_BASE_URL=https://api.example.com`：只填服务根地址，
 *   不要带结尾 `/`，也不要包含 `/api`（前缀由本模块统一拼接）。
 */
export const API_BASE_URL = normalizeBaseUrl(
  import.meta.env.VITE_API_BASE_URL,
)

/** 通用请求支持的方法，均为大写，与 fetch 保持一致。 */
export type ApiHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** 所有后端请求共有的可选项。 */
export interface ApiCallOptions {
  /**
   * 跳过全局错误提示（轮询、后台预取等场景）。
   * 错误对象仍会被归一化并抛出，便于调用方自行处理。
   */
  silent?: boolean
  /**
   * 超时时间（毫秒），默认 {@link DEFAULT_API_TIMEOUT_MS}；
   * 传 `0` 或负数表示不限制超时。
   */
  timeoutMs?: number
  /** 外部取消信号，与超时信号合并后一起生效。 */
  signal?: AbortSignal
  /** 额外请求头，会与默认请求头合并。 */
  headers?: HeadersInit
}

/** 通用 {@link request} 的选项。 */
export interface ApiRequestOptions extends ApiCallOptions {
  /** HTTP 方法，默认 `GET`。 */
  method?: ApiHttpMethod
  /** 查询参数，由生成的 client 统一序列化（数组、对象均支持）。 */
  query?: Record<string, unknown>
  /** 请求体，默认按 JSON 序列化。 */
  body?: unknown
}

// 模块加载时完成一次全局配置；生成的 client 是单例，所有 SDK 方法共享。
client.setConfig({
  baseUrl: API_BASE_URL,
  // 为后续基于 Cookie 的登录态预留；同源请求不受影响。
  credentials: 'include',
  headers: {
    Accept: 'application/json',
  },
})

// 安装统一错误拦截器；内部按 WeakSet 去重，重复调用无副作用。
installHttpErrorHandler(client)

/**
 * 把业务路径转换成后端真实地址。
 *
 * - `health`、`/health` → `/api/health`
 * - `/api/health` 保持不变，避免重复前缀
 * - `https://...` 等绝对地址直接返回，便于对接第三方接口
 */
export function resolveApiPath(path: string): string {
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(path)) {
    return path
  }

  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`

  if (
    withLeadingSlash === API_PREFIX ||
    withLeadingSlash.startsWith(`${API_PREFIX}/`)
  ) {
    return withLeadingSlash
  }

  return `${API_PREFIX}${withLeadingSlash}`
}

/**
 * 发起一次后端请求。
 *
 * 成功时返回响应体（已按 `Content-Type` 解析）；失败时抛出
 * {@link ApiError}。路径不需要写 `/api` 前缀。
 *
 * @typeParam T 期望的响应体类型，由调用方根据后端接口声明
 */
export async function request<T = unknown>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const {
    method = 'GET',
    body,
    query,
    headers,
    silent,
    timeoutMs,
    signal,
  } = options

  const requestOptions = {
    url: resolveApiPath(path),
    method,
    body,
    query,
    headers,
    signal: withTimeoutSignal(signal, timeoutMs),
    meta: silent ? { silent: true } : undefined,
    throwOnError: true as const,
    responseStyle: 'data' as const,
  }

  try {
    // 先构造对象再传入，避免 `meta` 触发多余属性检查（生成的
    // RequestOptions 类型未声明 meta，但运行时会被透传给错误拦截器）。
    // 生成的返回类型会把对象形态的 T 映射为 `T[keyof T]`，这里按调用方
    // 声明的响应体类型还原。
    return (await client.request<T, unknown, true, 'data'>(
      requestOptions,
    )) as T
  } catch (error) {
    throw toApiError(error)
  }
}

/** 只允许查询参数、不允许请求体的请求选项。 */
type BodylessRequestOptions = Omit<ApiRequestOptions, 'method' | 'body'>

/** `GET` 请求的语法糖，路径不需要写 `/api` 前缀。 */
export function get<T = unknown>(
  path: string,
  options: BodylessRequestOptions = {},
): Promise<T> {
  return request<T>(path, { ...options, method: 'GET' })
}

/** `POST` 请求的语法糖。 */
export function post<T = unknown>(
  path: string,
  body?: unknown,
  options: BodylessRequestOptions = {},
): Promise<T> {
  return request<T>(path, { ...options, method: 'POST', body })
}

/** `PUT` 请求的语法糖。 */
export function put<T = unknown>(
  path: string,
  body?: unknown,
  options: BodylessRequestOptions = {},
): Promise<T> {
  return request<T>(path, { ...options, method: 'PUT', body })
}

/** `PATCH` 请求的语法糖。 */
export function patch<T = unknown>(
  path: string,
  body?: unknown,
  options: BodylessRequestOptions = {},
): Promise<T> {
  return request<T>(path, { ...options, method: 'PATCH', body })
}

/** `DELETE` 请求的语法糖（`delete` 是保留字，因此命名为 `remove`）。 */
export function remove<T = unknown>(
  path: string,
  options: BodylessRequestOptions = {},
): Promise<T> {
  return request<T>(path, { ...options, method: 'DELETE' })
}

/**
 * 健康检查接口。
 *
 * 与 `docs/api/health.md` 一一对应；失败时后端返回 503，错误信息会被
 * 统一归一化为 {@link ApiError}。
 */
export const healthApi = {
  /** 检查后端进程是否存活（`GET /api/health`，不访问数据库与 COS）。 */
  async check(options: ApiCallOptions = {}): Promise<HealthCheckResponse> {
    const { data } = await healthCheck(toSdkOptions(options))
    return data
  },

  /** 检查 PostgreSQL 连通性（`GET /api/health/database`）。 */
  async checkDatabase(
    options: ApiCallOptions = {},
  ): Promise<ComponentHealthResponse> {
    const { data } = await healthCheckDatabase(toSdkOptions(options))
    return data
  },

  /** 检查腾讯云 COS 连通性（`GET /api/health/cos`）。 */
  async checkCos(
    options: ApiCallOptions = {},
  ): Promise<ComponentHealthResponse> {
    const { data } = await healthCheckCos(toSdkOptions(options))
    return data
  },
}

/**
 * 按业务域聚合的 API 入口。
 *
 * 页面组件统一使用 `api.health.*`、`api.get(...)` 这样的形式调用，
 * 后续新增知识库、文档、检索等业务域时在此处扩展即可。
 */
export const api = {
  request,
  get,
  post,
  put,
  patch,
  remove,
  health: healthApi,
} as const

// 统一从本模块导出错误类型与响应类型，业务代码无需再深入 `src/client`。
export { ApiError, handleApiError, isApiError }
export type { ComponentHealthResponse, HealthCheckResponse }

/** 把 SDK 调用选项转换成生成的 client 所需结构。 */
function toSdkOptions(options: ApiCallOptions = {}) {
  return {
    headers: options.headers,
    meta: options.silent ? { silent: true } : undefined,
    signal: withTimeoutSignal(options.signal, options.timeoutMs),
    throwOnError: true as const,
  }
}

/**
 * 合并外部取消信号与超时信号。
 *
 * `AbortSignal.timeout()` 触发时以 `TimeoutError` 拒绝，错误归一化逻辑
 * 会据此把错误标记为超时（`code === 'request_timeout'`）而不是用户取消。
 */
function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const timeout = timeoutMs ?? DEFAULT_API_TIMEOUT_MS

  if (!Number.isFinite(timeout) || timeout <= 0) {
    return signal
  }

  const timeoutSignal = AbortSignal.timeout(timeout)

  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

/** 保证错误一定是 {@link ApiError}，拦截器未覆盖的异常在此兜底。 */
function toApiError(error: unknown): ApiError {
  return isApiError(error) ? error : handleApiError(error, { silent: true })
}

/** 去掉末尾 `/`，允许用户误写成 `https://api.example.com/`。 */
function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim().replace(/\/+$/, '')
}
