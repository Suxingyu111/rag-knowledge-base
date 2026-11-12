import { DeleteOutlined, DownOutlined, MessageOutlined } from '@ant-design/icons'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Popconfirm, Spin } from 'antd'
import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import { conversationListKey, historyKey } from '@/api/chatQueries'
import { api } from '@/api/client'
import type { ConversationPage } from '@/client/types.gen'
import { ROUTE_PATHS } from '@/routes/paths'
import { useChatStore } from '@/stores/chatStore'

export default function ConversationSidebar({
  onSelect,
}: { onSelect: () => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const active = location.pathname === ROUTE_PATHS.chat
  const currentId = active ? new URLSearchParams(location.search).get('conversation') : null
  const [expanded, setExpanded] = useState<boolean>()
  const open = expanded ?? active
  const turns = useChatStore((state) => state.turns)
  const deletingId = useChatStore((state) => state.deletingId)
  const list = useInfiniteQuery({
    queryKey: conversationListKey,
    initialPageParam: 1,
    enabled: open,
    queryFn: ({ pageParam, signal }) => api.get<ConversationPage>('/conversations', {
      query: { page: pageParam, page_size: 20 },
      signal,
      silent: true,
    }),
    getNextPageParam: ({ page, page_size, total }) =>
      page * page_size < total ? page + 1 : undefined,
  })
  const items = Array.from(new Map(
    list.data?.pages.flatMap(({ items }) => items.map((item) => [item.id, item] as const)),
  ).values())

  async function remove(id: string) {
    try {
      if (!await useChatStore.getState().deleteConversation(id)) return
      // 确认期间仍可切换会话，按删除完成时的 URL 判断是否需要跳转。
      const current = new URL(window.location.href)
      if (current.pathname === ROUTE_PATHS.chat && current.searchParams.get('conversation') === id) {
        onSelect()
        navigate(ROUTE_PATHS.chat, { replace: true })
      }
      await queryClient.cancelQueries({ queryKey: historyKey(id) })
      queryClient.removeQueries({ queryKey: historyKey(id) })
      queryClient.setQueryData<typeof list.data>(conversationListKey, (cached) => cached && ({
        ...cached,
        pages: cached.pages.map((page) => ({
          ...page,
          items: page.items.filter((item) => item.id !== id),
        })),
      }))
      await queryClient.invalidateQueries({ queryKey: conversationListKey })
    } catch {
      // 统一请求层展示删除错误。
    }
  }

  return (
    <section className="kb-conversations" aria-label="知识问答会话">
      <div className={active ? 'kb-conversations-title is-active' : 'kb-conversations-title'}>
        <Link to={ROUTE_PATHS.chat} onClick={() => { setExpanded(true); onSelect() }}>
          <MessageOutlined /> 知识问答
        </Link>
        <Button
          aria-expanded={open}
          aria-label={open ? '收起会话列表' : '展开会话列表'}
          icon={<DownOutlined rotate={open ? 0 : -90} />}
          onClick={() => setExpanded(!open)}
          size="small"
          type="text"
        />
      </div>
      {open && (
        <div className="kb-conversations-list">
          {list.isPending && <Spin size="small" />}
          {list.isError && (
            <Button type="text" size="small" onClick={() => { void list.refetch() }}>
              加载失败，重试
            </Button>
          )}
          {list.isSuccess && !items.length && <span className="kb-conversations-empty">暂无会话</span>}
          {items.map(({ id, title }) => {
            const pending = turns[id]?.some((turn) => turn.pending)
            return (
              <div key={id} className={id === currentId ? 'kb-conversation is-active' : 'kb-conversation'}>
                <Link
                  aria-current={id === currentId ? 'page' : undefined}
                  onClick={onSelect}
                  title={title}
                  to={`${ROUTE_PATHS.chat}?conversation=${encodeURIComponent(id)}`}
                >
                  {title}
                </Link>
                <Popconfirm
                  title="删除这个会话？"
                  description="会话中的消息和引用也会被删除。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => remove(id)}
                >
                  <Button
                    aria-label={`删除会话：${title}`}
                    disabled={Boolean(deletingId || pending)}
                    icon={<DeleteOutlined />}
                    loading={deletingId === id}
                    size="small"
                    type="text"
                  />
                </Popconfirm>
              </div>
            )
          })}
          {list.hasNextPage && (
            <Button type="text" size="small" loading={list.isFetching} onClick={() => { void list.fetchNextPage() }}>
              加载更多
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
