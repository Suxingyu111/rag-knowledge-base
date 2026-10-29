import { Button, Result, Space } from 'antd'
import {
  isRouteErrorResponse,
  useNavigate,
  useRouteError,
} from 'react-router-dom'

import { ROUTE_PATHS } from '@/routes/paths'
import './FallbackPage.css'

/** 把路由异常转换成可以直接展示给用户的文案。 */
function resolveErrorDetail(error: unknown): string {
  if (isRouteErrorResponse(error)) {
    return `${error.status} ${error.statusText}`.trim()
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return '页面渲染时出现未知错误，请稍后重试。'
}

/**
 * 路由级错误边界。
 *
 * 配置在根路由的 `errorElement` 上：布局或页面渲染抛错时会替换整个
 * 应用外壳，避免 React 卸载整棵树后留下白屏。
 */
export default function RouteErrorPage() {
  const error = useRouteError()
  const navigate = useNavigate()

  return (
    <main className="kb-fallback kb-fallback--full">
      <Result
        extra={
          <Space wrap>
            <Button onClick={() => window.location.reload()} type="primary">
              重新加载
            </Button>
            <Button onClick={() => navigate(ROUTE_PATHS.chat)}>回到首页</Button>
          </Space>
        }
        status="500"
        subTitle={resolveErrorDetail(error)}
        title="页面暂时无法显示"
      />
    </main>
  )
}
