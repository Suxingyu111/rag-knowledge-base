/* oxlint-disable react/only-export-components -- 路由表是模块级配置，不参与 Fast Refresh。 */
import { Navigate, createBrowserRouter } from 'react-router-dom'

import BasicLayout from '@/layouts/BasicLayout'
import ChatPage from '@/pages/ChatPage'
import DocumentsPage from '@/pages/DocumentsPage'
import DocumentDetailPage from '@/pages/DocumentDetailPage'
import DocumentPreviewPage from '@/pages/DocumentPreviewPage'
import EvaluationsPage from '@/pages/EvaluationsPage'
import EvaluationDetailPage from '@/pages/EvaluationDetailPage'
import HomePage from '@/pages/HomePages'
import KnowledgeBasePage from '@/pages/KnowledgeBasePage'
import NotFoundPage from '@/pages/NotFoundPage'
import RouteErrorPage from '@/pages/RouteErrorPage'
import { ROUTE_PATHS } from '@/routes/paths'

/**
 * 路由表：URL 与页面组件的唯一映射。
 *
 * 层级约定：
 * - 根路由渲染 `BasicLayout`（侧边栏 + 顶栏 + 内容区），所有业务页面都是
 *   它的子路由，通过 `<Outlet />` 渲染，因此切换页面不会重建应用外壳；
 * - `index` 路由把 `/` 重定向到 `/chat`，`replace` 避免在历史记录里留下
 *   一条无意义的中转记录；
 * - 未知地址落到布局内的 404 页面，用户仍可继续使用导航；
 * - `errorElement` 挂在根路由上，页面或布局渲染抛错时展示统一错误页，
 *   而不是卸载整棵树后留下白屏。
 *
 * 新增页面时：在 `paths.ts` 声明路径 → 在 `children` 中登记
 * `{ path, element }` → 如有需要再到 `BasicLayout` 的 `NAV_ITEMS` 添加导航。
 */
export const router = createBrowserRouter([
  {
    path: ROUTE_PATHS.documentPreview,
    element: <DocumentPreviewPage />,
    errorElement: <RouteErrorPage />,
  },
  {
    path: ROUTE_PATHS.root,
    element: <BasicLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        path: ROUTE_PATHS.documents,
        element: <DocumentsPage />,
      },
      {
        path: ROUTE_PATHS.documentDetail,
        element: <DocumentDetailPage />,
      },
      {
        index: true,
        element: <Navigate replace to={ROUTE_PATHS.chat} />,
      },
      {
        path: ROUTE_PATHS.chat,
        element: <ChatPage />,
      },
      {
        path: 'knowledge-base',
        element: <KnowledgeBasePage />,
      },
      {
        path: ROUTE_PATHS.evaluations,
        element: <EvaluationsPage />,
      },
      {
        path: ROUTE_PATHS.evaluationDetail,
        element: <EvaluationDetailPage />,
      },
      {
        path: 'health',
        element: <HomePage />,
      },
      {
        path: '*',
        element: <NotFoundPage />,
      },
    ],
  },
])

export { ROUTE_PATHS } from '@/routes/paths'
export type { RoutePath } from '@/routes/paths'
