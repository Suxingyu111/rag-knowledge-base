import { Button, Result } from 'antd'
import { useNavigate } from 'react-router-dom'

import { ROUTE_PATHS } from '@/routes/paths'
import './FallbackPage.css'

/**
 * 未匹配到任何路由时的兜底页面。
 *
 * 挂在布局路由的 `*` 子路由上，因此仍然保留侧边栏与顶栏，用户可以
 * 继续在应用内切换页面，而不是看到一张白屏。
 */
export default function NotFoundPage() {
  const navigate = useNavigate()

  return (
    <section className="kb-fallback">
      <Result
        extra={
          <Button
            onClick={() => navigate(ROUTE_PATHS.chat)}
            type="primary"
          >
            回到知识问答
          </Button>
        }
        status="404"
        subTitle="你访问的地址没有对应的页面，可能已经被移动或删除。"
        title="页面不存在"
      />
    </section>
  )
}
