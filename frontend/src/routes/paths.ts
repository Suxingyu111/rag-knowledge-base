/**
 * 全站路由路径的唯一来源。
 *
 * 页面跳转、导航高亮、面包屑和 `routes/index.tsx` 都从这里取路径，
 * 避免在组件里散落字符串字面量——改地址时只需要改这一处。
 */
export const ROUTE_PATHS = {
  /** 应用根路径，访问时重定向到知识问答。 */
  root: '/',
  /** 知识问答。 */
  chat: '/chat',
  /** 知识库列表与管理。 */
  knowledgeBase: '/knowledge-base',
  /** 后端服务、数据库与 COS 的运行状态。 */
  health: '/health',
} as const

/** 所有已声明路径组成的联合类型。 */
export type RoutePath = (typeof ROUTE_PATHS)[keyof typeof ROUTE_PATHS]
