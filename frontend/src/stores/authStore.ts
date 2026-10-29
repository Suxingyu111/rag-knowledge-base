/**
 * 全局登录态与当前用户信息。
 *
 * 职责边界（重要）：
 * - 只保存「当前会话」的前端状态：登录状态、当前用户资料快照。
 * - 不保存任何服务端数据：知识库、文档、对话、检索结果等由接口获取的
 *   数据一律交给 React Query（`@tanstack/react-query`）按查询键缓存，
 *   避免同一份数据在两套状态里各存一份、互相不同步。
 * - 不做持久化：当前版本不写 `localStorage` / `sessionStorage`。接入 JWT
 *   后再决定凭证的存放方式（优先 HttpOnly Cookie，前端不可读更安全），
 *   用户资料快照也不建议长期落盘，避免展示过期信息。
 *
 * 当前为占位实现：
 * - 后端还没有登录接口，{@link AuthState.setSession} 直接接收调用方传入
 *   的用户对象，只在本地切换登录状态，不发起任何网络请求。
 * - 接入 JWT 时新增异步 action（如 `login` / `logout` / `restoreSession`），
 *   在接口成功后再调用 {@link AuthState.setSession} 或
 *   {@link AuthState.clearSession}。这样状态结构与页面选择器都不需要改，
 *   已有的 UI 代码也不用跟着改名。
 * - 401 的统一处理可以在 `src/utils/errors.ts` 的
 *   `configureHttpErrorHandling({ onError })` 中判断 `error.status === 401`，
 *   然后调用 `useAuthStore.getState().clearSession()` 并跳转登录页。
 *
 * @example
 * ```tsx
 * import {
 *   useAuthStore,
 *   selectCurrentUser,
 *   selectIsAuthenticated,
 * } from '@/stores/authStore'
 *
 * function AccountEntry() {
 *   const user = useAuthStore(selectCurrentUser)
 *   const isAuthenticated = useAuthStore(selectIsAuthenticated)
 *
 *   if (!isAuthenticated || !user) {
 *     return <span>未登录</span>
 *   }
 *
 *   return <span>{user.displayName ?? user.username}</span>
 * }
 *
 * // 非组件环境（HTTP 拦截器、路由守卫等）直接读取当前快照
 * const { status, user } = useAuthStore.getState()
 * ```
 */
import { create } from 'zustand'

/**
 * 登录状态。
 *
 * 用显式状态机而不是布尔值，是为了给 JWT 会话恢复留出过渡态：
 * 应用启动时先校验本地凭证，校验完成前既不能当作已登录，也不应闪一下
 * 未登录界面。
 */
export type AuthStatus =
  /** 未登录：没有有效登录态。 */
  | 'anonymous'
  /** 登录态校验中：读取/刷新 JWT、拉取当前用户时的过渡态（占位，暂未使用）。 */
  | 'authenticating'
  /** 已登录：此时 {@link AuthState.user} 一定存在。 */
  | 'authenticated'

/**
 * 当前登录用户的资料快照。
 *
 * 字段与后端用户模型尚无对应实现，先按界面需要约定最小集合；
 * 后续接入 JWT 时按后端返回结构补充（如 `roles`、`createdAt` 等）。
 */
export interface AuthUser {
  /** 用户唯一标识，对应后端用户主键。 */
  id: string
  /** 登录账号。 */
  username: string
  /** 展示名，界面优先展示；为空时回退到 {@link AuthUser.username}。 */
  displayName?: string
  /** 邮箱，供资料页使用。 */
  email?: string
  /** 头像地址，为空时展示用户名首字母。 */
  avatarUrl?: string
}

/** 允许在本地更新的用户字段；`id` 是身份标识，不允许修改。 */
export type AuthUserPatch = Partial<Omit<AuthUser, 'id'>>

/** 登录态 store 的完整状态与 action。 */
export interface AuthState {
  /** 当前登录状态，唯一事实来源；`authenticated` 时 `user` 必然非空。 */
  status: AuthStatus
  /** 当前用户资料快照；未登录或校验中为 `null`。 */
  user: AuthUser | null

  /**
   * 写入登录态（占位）。
   *
   * 只做本地状态切换，不做校验、不发请求；调用方需保证传入的是已经
   * 确认过的用户信息。接入 JWT 后由 `login` / `restoreSession` 在接口
   * 成功之后调用。
   */
  setSession: (user: AuthUser) => void

  /**
   * 清空登录态（占位）。
   *
   * 只清理前端状态。接入 JWT 后，`logout` 还需要调用登出接口，并按需
   * 清理 React Query 缓存（`queryClient.clear()`），避免下一个用户看到
   * 上一个账号的数据。
   */
  clearSession: () => void

  /**
   * 更新当前用户资料（仅本地）。
   *
   * 用于资料编辑成功后同步 store。服务端数据仍以后端返回为准，
   * 不要借此在 store 中缓存其他业务数据；未登录时调用为空操作。
   */
  updateUser: (patch: AuthUserPatch) => void
}

/**
 * 全局登录态 store。
 *
 * 组件中用选择器订阅，避免无关字段变化引起重渲染：
 * `useAuthStore(selectCurrentUser)`。
 */
export const useAuthStore = create<AuthState>()((set, get) => ({
  status: 'anonymous',
  user: null,

  setSession: (user) => {
    // TODO(JWT): 由 login / restoreSession 在拿到后端确认的用户信息后调用。
    // 若采用 HttpOnly Cookie，凭证不在前端保存；若采用 Bearer Token，
    // 在此处之外的 auth 模块统一管理，不放进本 store。
    set({ status: 'authenticated', user })
  },

  clearSession: () => {
    // TODO(JWT): 由 logout 在调用登出接口后调用，并清理 token 与查询缓存。
    set({ status: 'anonymous', user: null })
  },

  updateUser: (patch) => {
    const { user } = get()

    if (!user) {
      return
    }

    set({ user: { ...user, ...patch } })
  },
}))

/** 读取当前登录状态。 */
export const selectAuthStatus = (state: AuthState): AuthStatus => state.status

/** 读取当前用户资料；未登录或校验中为 `null`。 */
export const selectCurrentUser = (state: AuthState): AuthUser | null =>
  state.user

/** 是否已登录，供路由守卫、按钮权限等场景使用。 */
export const selectIsAuthenticated = (state: AuthState): boolean =>
  state.status === 'authenticated'
