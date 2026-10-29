import '@/index.css'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'

// 触发统一 HTTP 客户端初始化：baseURL、超时、凭证与全局错误拦截器。
// 必须早于首次请求（RouterProvider 内的页面挂载时就会发起健康检查）。
import '@/api/client'
import { router } from '@/routes'
import { APP_THEME } from '@/theme/antd'

/**
 * TanStack Query 全局实例。
 *
 * 全应用只创建一次：查询缓存、重试策略与请求去重都共享这一份配置。
 * - `staleTime`：30 秒内复用缓存，避免路由来回切换时重复请求；
 * - `retry`：失败后最多重试一次，由后端错误码决定是否值得重试的场景
 *   后续可在具体 `useQuery` 中覆盖；
 * - `refetchOnWindowFocus`：知识库类数据不随窗口聚焦频繁刷新。
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
})

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('未找到 #root 挂载节点，请检查 index.html')
}

/**
 * 全局 Provider 的嵌套顺序：
 *
 * 1. `StrictMode`：开发环境检查副作用与过时 API；
 * 2. `ConfigProvider`：Ant Design 中文 locale + 全站主题令牌，位于最外层，
 *    保证后续所有弹层（Modal、message、Drawer）共享同一份配置；
 * 3. `AntApp`：提供 `App.useApp()` 上下文。布局里的全局错误提示与页面
 *    里的 `message` 都依赖它，必须包在 RouterProvider 外侧；
 * 4. `QueryClientProvider`：注入 TanStack Query 缓存，页面可直接用
 *    `useQuery` / `useMutation`；
 * 5. `RouterProvider`：最后挂载路由，决定当前 URL 渲染哪个页面。
 */
createRoot(rootElement).render(
  <StrictMode>
    <ConfigProvider locale={zhCN} theme={APP_THEME}>
      <AntApp className="kb-app">
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
)
