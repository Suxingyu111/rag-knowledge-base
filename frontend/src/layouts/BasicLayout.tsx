import {
  ApiOutlined,
  BarChartOutlined,
  CloseOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  PlusOutlined,
  ReadOutlined,
} from '@ant-design/icons'
import { App as AntApp, Avatar, Button, Drawer, Layout, Menu } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import type { MenuProps } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'

import { conversationListKey } from '@/api/chatQueries'
import ConversationSidebar from '@/components/ConversationSidebar'
import { useChatStore } from '@/stores/chatStore'
import { ROUTE_PATHS } from '@/routes/paths'
import type { RoutePath } from '@/routes/paths'
import { setErrorNotifier } from '@/utils/errors'
import './BasicLayout.css'

const { Header, Sider, Content } = Layout

type NavKey = 'chat' | 'knowledge-base' | 'documents' | 'evaluations' | 'health'

interface NavItem {
  key: NavKey
  path: RoutePath
  label: string
}

interface SidebarContentProps {
  activeKey: NavKey | null
  collapsed: boolean
  onClose?: () => void
  onSelectConversation: () => void
  onNavigate: (key: NavKey) => void
}

/**
 * 布局通过 `<Outlet context>` 暴露给页面组件的工作区状态。
 *
 * 输入框草稿放在布局层，切换 `/chat` 与 `/knowledge-base` 时不会丢失；
 * 页面组件用 `useOutletContext<WorkspaceOutletContext>()` 读取。
 */
export interface WorkspaceOutletContext {
  question: string
  setQuestion: (value: string) => void
}

/**
 * 侧边栏导航项。
 *
 * `path` 必须来自 `ROUTE_PATHS`，并用 `routes/index.tsx` 中的子路由
 * 一一对应；高亮状态由当前 URL 推导，不再维护独立的选中状态。
 */
const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'chat',
    path: ROUTE_PATHS.chat,
    label: '知识问答',
  },
  {
    key: 'knowledge-base',
    path: ROUTE_PATHS.knowledgeBase,
    label: '知识库',
  },
  {
    key: 'documents',
    path: ROUTE_PATHS.documents,
    label: '文档管理',
  },
  {
    key: 'evaluations',
    path: ROUTE_PATHS.evaluations,
    label: '评测分析',
  },
  {
    key: 'health',
    path: ROUTE_PATHS.health,
    label: '系统状态',
  },
]

const NAV_ICONS: Record<NavKey, ReactNode> = {
  chat: <MessageOutlined />,
  'knowledge-base': <DatabaseOutlined />,
  documents: <FileTextOutlined />,
  evaluations: <BarChartOutlined />,
  health: <ApiOutlined />,
}

const WORKSPACE_NAV_KEYS: readonly NavKey[] = ['chat', 'knowledge-base', 'evaluations']

function toMenuItem({ key, label }: NavItem) {
  return { key, icon: NAV_ICONS[key], label }
}

const menuItems = (collapsed: boolean): MenuProps['items'] => [
  {
    type: 'group',
    key: 'workspace',
    label: '工作台',
    children: NAV_ITEMS.filter((item) =>
      WORKSPACE_NAV_KEYS.includes(item.key) && (collapsed || item.key !== 'chat'),
    ).map(toMenuItem),
  },
  {
    type: 'group',
    key: 'knowledge-assets',
    label: '知识资产',
    children: [
      ...NAV_ITEMS.filter((item) => item.key === 'documents').map(toMenuItem),
      {
        key: 'knowledge-documents',
        icon: <ReadOutlined />,
        disabled: true,
        label: (
          <span className="kb-menu-label">
            <span>知识文档</span>
            <span className="kb-soon">即将开放</span>
          </span>
        ),
      },
    ],
  },
  {
    type: 'group',
    key: 'system',
    label: '系统',
    children: NAV_ITEMS.filter((item) => item.key === 'health').map(toMenuItem),
  },
]

const TODAY_LABEL = new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric',
  weekday: 'long',
}).format(new Date())

/** 按路径边界匹配导航项；/documents 及其详情页共用菜单高亮与面包屑标题。 */
function resolveNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find(
    ({ path }) => pathname === path || pathname.startsWith(`${path}/`),
  )
}

function SidebarContent({
  activeKey,
  collapsed,
  onClose,
  onSelectConversation,
  onNavigate,
}: SidebarContentProps) {
  return (
    <div className={`kb-sidebar${collapsed ? ' is-collapsed' : ''}`}>
      {onClose ? (
        <Button
          aria-label="关闭导航"
          className="kb-drawer-close"
          icon={<CloseOutlined />}
          onClick={onClose}
          type="text"
        />
      ) : null}

      <div className="kb-brand">
        <span className="kb-mark" aria-hidden="true">
          <span>知</span>
        </span>
        {!collapsed ? (
          <span className="kb-brand-copy">
            <strong>知源</strong>
            <span>RAG KNOWLEDGE</span>
          </span>
        ) : null}
      </div>

      <div className="kb-sidebar-divider" />

      <div className="kb-nav-scroll">
        {!collapsed && <ConversationSidebar onSelect={onSelectConversation} />}
        <Menu
          className="kb-nav"
          inlineCollapsed={collapsed}
          items={menuItems(collapsed)}
          mode="inline"
          onClick={({ key }) => {
            const item = NAV_ITEMS.find((navItem) => navItem.key === key)

            if (item) {
              onNavigate(item.key)
            }
          }}
          selectedKeys={activeKey ? [activeKey] : []}
          theme="dark"
        />
      </div>

      <div className="kb-sidebar-footer">
        {!collapsed ? (
          <div className="kb-connection">
            <span className="kb-connection-dot" aria-hidden="true" />
            <div>
              <strong>知识库未连接</strong>
              <span>连接后即可开始检索</span>
            </div>
          </div>
        ) : null}

        <div className="kb-account" title="知识管理员">
          <Avatar className="kb-account-avatar" size={collapsed ? 30 : 36}>
            知
          </Avatar>
          {!collapsed ? (
            <div className="kb-account-copy">
              <strong>知识管理员</strong>
              <span>个人工作区</span>
            </div>
          ) : null}
        </div>

        {!collapsed ? (
          <p className="kb-version">RAG KNOWLEDGE BASE · V0.1</p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 应用外壳：侧边栏、顶栏与内容区。
 *
 * 全局 Provider（ConfigProvider / AntApp / QueryClientProvider /
 * RouterProvider）统一在 `main.tsx` 中装配，本组件只负责布局与导航；
 * 页面内容由路由的 `<Outlet />` 决定，当前地址是菜单高亮的唯一来源。
 */
export default function BasicLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia('(max-width: 991.98px)').matches,
  )
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const creatingChat = useChatStore((state) => state.creating)
  const { message } = AntApp.useApp()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const activeItem = resolveNavItem(pathname)
  const activeKey = activeItem?.key ?? null

  // 把 App 上下文中的 message 交给全局 HTTP 错误处理，提示才能跟随主题
  useEffect(() => setErrorNotifier(message), [message])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 991.98px)')

    const handleBreakpointChange = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches)
      if (!event.matches) {
        setMobileNavOpen(false)
      }
    }

    mediaQuery.addEventListener('change', handleBreakpointChange)
    return () =>
      mediaQuery.removeEventListener('change', handleBreakpointChange)
  }, [])

  const outletContext = useMemo<WorkspaceOutletContext>(
    () => ({ question, setQuestion }),
    [question],
  )

  const handleNavigate = (key: NavKey) => {
    setMobileNavOpen(false)

    const item = NAV_ITEMS.find((navItem) => navItem.key === key)

    if (item && item.path !== pathname) {
      navigate(item.path)
    }
  }

  const handleSelectConversation = () => {
    setQuestion('')
    setMobileNavOpen(false)
  }

  const handleNewChat = async () => {
    try {
      const conversation = await useChatStore.getState().createConversation()
      if (!conversation) return
      handleSelectConversation()
      void queryClient.invalidateQueries({ queryKey: conversationListKey })
      navigate(`${ROUTE_PATHS.chat}?conversation=${encodeURIComponent(conversation.id)}`)
    } catch {
      // 统一请求层负责显示创建失败提示。
    }
  }

  return (
    <Layout className="kb-shell">
      <a className="kb-skip-link" href="#kb-main-content">
        跳到主要内容
      </a>

      {!isMobile ? (
        <Sider
          breakpoint="lg"
          className="kb-sider"
          collapsed={collapsed}
          collapsedWidth={84}
          onBreakpoint={setIsMobile}
          onCollapse={setCollapsed}
          theme="dark"
          trigger={null}
          width={272}
        >
          <SidebarContent
            activeKey={activeKey}
            collapsed={collapsed}
            onNavigate={handleNavigate}
            onSelectConversation={handleSelectConversation}
          />
        </Sider>
      ) : null}

      <Layout className="kb-main">
        <Header className="kb-header">
          <div className="kb-header-left">
            <Button
              aria-label={
                isMobile
                  ? '打开导航'
                  : collapsed
                    ? '展开侧边栏'
                    : '收起侧边栏'
              }
              className="kb-nav-toggle"
              icon={
                isMobile ? (
                  <MenuOutlined />
                ) : collapsed ? (
                  <MenuUnfoldOutlined />
                ) : (
                  <MenuFoldOutlined />
                )
              }
              onClick={() => {
                if (isMobile) {
                  setMobileNavOpen(true)
                  return
                }
                setCollapsed((value) => !value)
              }}
              type="text"
            />

            <nav aria-label="面包屑" className="kb-breadcrumb">
              <span className="kb-breadcrumb-root">知源</span>
              <span aria-hidden="true" className="kb-breadcrumb-slash">
                /
              </span>
              <strong>{activeItem?.label ?? '页面不存在'}</strong>
            </nav>
          </div>

          <div className="kb-header-right">
            {activeKey !== 'chat' && (
              <>
                <span className="kb-date">{TODAY_LABEL}</span>
                <span className="kb-workspace-pill">
                  <span aria-hidden="true" className="kb-workspace-dot" />
                  本地工作区
                </span>
              </>
            )}
            <Button
              className="kb-new-chat"
              icon={<PlusOutlined />}
              loading={creatingChat}
              onClick={handleNewChat}
              type="primary"
            >
              <span className="kb-new-chat-text">新建对话</span>
            </Button>
          </div>
        </Header>

        <Content className={activeKey === 'chat' ? 'kb-content kb-content--chat' : 'kb-content'} id="kb-main-content">
          <div className="kb-content-glow" aria-hidden="true" />
          <div className={activeKey === 'evaluations' ? 'kb-stage-wrap kb-stage-wrap--evaluations' : 'kb-stage-wrap'} key={pathname}>
            <Outlet context={outletContext} />
          </div>
        </Content>
      </Layout>

      {isMobile && <Drawer
        className="kb-drawer"
        closable={false}
        mask={{ blur: true }}
        onClose={() => setMobileNavOpen(false)}
        open={isMobile && mobileNavOpen}
        placement="left"
        size={292}
        styles={{
          body: {
            background:
              'radial-gradient(circle at 16% -8%, rgba(214, 228, 190, 0.16), transparent 36%), linear-gradient(170deg, #1a2720 0%, #121b16 58%, #0e1611 100%)',
            padding: 0,
          },
        }}
      >
        <SidebarContent
          activeKey={activeKey}
          collapsed={false}
          onClose={() => setMobileNavOpen(false)}
          onNavigate={handleNavigate}
          onSelectConversation={handleSelectConversation}
        />
      </Drawer>}
    </Layout>
  )
}
