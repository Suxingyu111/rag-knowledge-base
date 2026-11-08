import { ArrowUpOutlined, DesktopOutlined, UserOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Input, Select, Spin } from 'antd'
import { useEffect, useRef, type ReactNode } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'

import { api } from '@/api/client'
import type { ConversationDetail, MessageRead } from '@/client/types.gen'
import CitationList from '@/components/CitationList'
import { useChatStore, useConversationIndex } from '@/stores/chatStore'

import StageHead from '@/components/StageHead'
import type { WorkspaceOutletContext } from '@/layouts/BasicLayout'
import './ChatPage.css'

const STAGE_COPY = {
  eyebrow: '01 / KNOWLEDGE CHAT',
  headline: (
    <>
      今天想从文档里，
      <br />
      <em>找到什么？</em>
    </>
  ),
  description:
    '用日常语言提问，知源会检索你的知识库，并给出可以回溯到原文的回答。',
} as const

const SUGGESTED_QUESTIONS = [
  '总结这份文档的核心结论',
  '这份合同有哪些风险条款？',
  '对比两个版本的差异',
]

function MessageBubble({ role, children }: { role: MessageRead['role']; children: ReactNode }) {
  const label = role === 'user' ? '你' : role === 'assistant' ? '知源' : '系统'

  return (
    <article className={`kb-chat-message kb-chat-message--${role}`} aria-label={label}>
      <span className="kb-chat-avatar" aria-hidden="true">
        {role === 'user' ? <UserOutlined /> : <DesktopOutlined />}
      </span>
      <div className="kb-chat-bubble">
        <strong className="kb-chat-sender">{label}</strong>
        {children}
      </div>
    </article>
  )
}

const historyKey = (id: string) => ['chat', 'history', id] as const

export function ChatPage() {
  const { question, setQuestion } = useOutletContext<WorkspaceOutletContext>()
  const [searchParams, setSearchParams] = useSearchParams()
  const conversationId = searchParams.get('conversation') ?? ''
  const conversations = useConversationIndex((state) => state.conversations)
  const turns = useChatStore((state) => state.turns[conversationId])
  const pending = turns?.some((turn) => turn.pending) ?? false
  const creating = useChatStore((state) => state.creating)
  const messages = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()
  const history = useQuery({
    queryKey: historyKey(conversationId),
    queryFn: ({ signal }) => api.get<ConversationDetail>(
      `/conversations/${encodeURIComponent(conversationId)}`, { signal, silent: true },
    ),
    enabled: Boolean(conversationId),
    refetchOnMount: 'always',
  })
  const saved = history.data?.messages ?? []
  const savedIds = new Set(saved.map(({ id }) => id))

  useEffect(() => {
    if (history.data) useConversationIndex.getState().remember(history.data.conversation)
  }, [history.data])

  useEffect(() => {
    const panel = messages.current
    if (panel) panel.scrollTop = panel.scrollHeight
  }, [conversationId, history.data, turns])

  const handleAsk = async () => {
    const text = question.trim()
    if (!text || creating || pending || (conversationId && !history.data)) return

    let id = conversationId
    if (!id) {
      try {
        const conversation = await useChatStore.getState().createConversation()
        if (!conversation) return
        id = conversation.id
        queryClient.setQueryData<ConversationDetail>(historyKey(id), { conversation, messages: [] })
        setSearchParams({ conversation: id })
      } catch {
        return
      }
    }
    setQuestion('')
    await useChatStore.getState().send(id, text)
    await queryClient.invalidateQueries({ queryKey: historyKey(id) })
  }

  return (
    <section className="kb-stage" aria-labelledby="kb-page-title">
      <StageHead {...STAGE_COPY} />

      <Select
        aria-label="历史会话"
        placeholder="打开历史会话"
        value={conversationId || undefined}
        disabled={creating}
        style={{ width: '100%', maxWidth: 360, marginBlockEnd: 16 }}
        options={conversations.map(({ id, title }) => ({ value: id, label: title }))}
        onChange={(id: string) => {
          setQuestion('')
          setSearchParams({ conversation: id })
        }}
      />

      {conversationId && (
        <div ref={messages} aria-label="会话消息" className="kb-chat-transcript">
          {history.isPending && <Spin />}
          {history.isError && (
            <Alert type="error" title="会话历史加载失败" description={history.error.message}
              action={<Button onClick={() => { void history.refetch() }}>重试</Button>} />
          )}
          {saved.map((item) => (
            <MessageBubble key={item.id} role={item.role}>
              {item.role === 'assistant'
                ? <CitationList answer={item.content} citations={item.citations ?? []} />
                : <div style={{ whiteSpace: 'pre-wrap' }}>{item.content}</div>}
            </MessageBubble>
          ))}
          {turns?.map((turn, index) => (
            <div key={index}>
              {(!turn.userId || !savedIds.has(turn.userId)) && (
                <MessageBubble role="user">
                  <div style={{ whiteSpace: 'pre-wrap' }}>{turn.question}</div>
                </MessageBubble>
              )}
              {(!turn.answerId || !savedIds.has(turn.answerId)) && (turn.answer || turn.pending) && (
                <MessageBubble role="assistant">
                  {turn.answer ? <CitationList answer={turn.answer} citations={turn.citations ?? []} /> : <p role="status">正在检索并生成回答…</p>}
                </MessageBubble>
              )}
              {turn.error && (
                <MessageBubble role="assistant">
                  <Alert type="error" title="回答中断" description={turn.error} />
                </MessageBubble>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="kb-composer-shell">
        <div className="kb-composer-head">
          <span className="kb-composer-label">向知识库提问</span>
          {pending && <span role="status">正在回答</span>}
        </div>
        <Input.TextArea
          aria-label="向知识库提问"
          autoSize={{ minRows: 3, maxRows: 6 }}
          className="kb-question-input"
          disabled={creating}
          maxLength={2000}
          onChange={(event) => setQuestion(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void handleAsk()
            }
          }}
          placeholder="例如：这份合同的付款周期是多久？"
          value={question}
          variant="borderless"
        />
        <div className="kb-composer-foot">
          <span>Enter 发送 · Shift + Enter 换行</span>
          <Button
            className="kb-send-button"
            disabled={!question.trim() || pending || Boolean(conversationId && !history.data)}
            loading={creating}
            onClick={handleAsk}
            type="primary"
          >
            发送
            <ArrowUpOutlined />
          </Button>
        </div>
      </div>

      <div className="kb-suggest-row">
        <span className="kb-suggest-label">不知道从哪问起？</span>
        <div className="kb-chip-row">
          {SUGGESTED_QUESTIONS.map((suggestion) => (
            <button
              className="kb-chip"
              key={suggestion}
              onClick={() => setQuestion(suggestion)}
              type="button"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>

      <footer className="kb-stage-note">
        <span className="kb-note-mark">RAG</span>
        <span>回答会附上文档引用，重要结论请回到原文核对。</span>
      </footer>
    </section>
  )
}

export default ChatPage
