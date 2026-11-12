import { ArrowUpOutlined, DesktopOutlined, UserOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Input, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useRef, type ReactNode } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'

import { api } from '@/api/client'
import type { ConversationDetail, MessageRead, QueryRouteRead, VerifyResultRead } from '@/client/types.gen'
import AgentRetrievalDetails from '@/components/AgentRetrievalDetails'
import CitationList from '@/components/CitationList'
import { useChatStore } from '@/stores/chatStore'
import { conversationListKey, historyKey } from '@/api/chatQueries'

import type { WorkspaceOutletContext } from '@/layouts/BasicLayout'
import './ChatPage.css'

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

const queryRouteLabels = {
  original: '原问题检索',
  rewrite: '改写问题',
  hyde: '假设性答案检索',
  multi_query: '多子查询检索',
} satisfies Record<QueryRouteRead['route'], string>

function QueryRouteDetails({ result }: { result?: QueryRouteRead | null }) {
  if (!result || !Object.hasOwn(queryRouteLabels, result.route)) return null

  const { route, query, rewritten_query, hyde_answer, multi_queries } = result
  const retrievalText = route === 'rewrite' ? rewritten_query || query
    : route === 'hyde' ? hyde_answer || query
      : query

  return (
    <details className="kb-chat-query-route">
      <summary>检索策略 · {queryRouteLabels[route]}</summary>
      {route === 'multi_query' && multi_queries?.length ? (
        <ol>
          {multi_queries.map((item, index) => <li key={index}>{item}</li>)}
        </ol>
      ) : (
        <p>
          {route === 'hyde' && <><strong>用于检索的假设文本</strong><br /></>}
          {retrievalText}
        </p>
      )}
    </details>
  )
}

function ContextCheck({ sufficient }: { sufficient?: boolean }) {
  if (sufficient == null) return null

  return (
    <div className="kb-chat-check" role="status">
      <Tag color={sufficient ? 'success' : 'warning'}>
        {sufficient ? '召回证据充足' : '召回证据不足'}
      </Tag>
    </div>
  )
}

function VerificationDetails({ result }: { result?: VerifyResultRead | null }) {
  if (!result) return null

  return (
    <div className="kb-chat-check" role="status">
      <Tag color={result.verified ? 'success' : 'warning'}>
        {result.verified ? '答案校验通过' : '答案校验未通过'}
      </Tag>
      {!result.verified && result.reason && <div>{result.reason}</div>}
    </div>
  )
}

function getTraceLink(traceUrl?: string | null) {
  if (!traceUrl) return null
  try {
    const url = new URL(traceUrl)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function AnswerTrace({ traceId, traceUrl }: {
  traceId?: string | null
  traceUrl?: string | null
}) {
  const href = getTraceLink(traceUrl)
  if (!href && !traceId) return null

  return (
    <div className="kb-chat-check">
      <Space wrap>
        {traceId && (
          <Typography.Text type="secondary" copyable={{ text: traceId, tooltips: ['复制追踪 ID', '已复制'] }}>
            LangSmith 追踪 ID
          </Typography.Text>
        )}
        {href && (
          <Typography.Link href={href} target="_blank" rel="noopener noreferrer">
            在LangSmith中查看
          </Typography.Link>
        )}
      </Space>
    </div>
  )
}

export function ChatPage() {
  const { question, setQuestion } = useOutletContext<WorkspaceOutletContext>()
  const [searchParams, setSearchParams] = useSearchParams()
  const conversationId = searchParams.get('conversation') ?? ''
  const deleting = useChatStore((state) => Boolean(conversationId && state.deletingId === conversationId))
  const turns = useChatStore((state) => state.turns[conversationId])
  const pending = turns?.some((turn) => turn.pending) ?? false
  const creating = useChatStore((state) => state.creating)
  const messages = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
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
  const contextByAnswer = new Map(turns?.map(({ answerId, contextSufficient }) => [answerId, contextSufficient]))

  useEffect(() => {
    followLatest.current = true
  }, [conversationId])

  useEffect(() => {
    const panel = messages.current
    if (panel && followLatest.current) panel.scrollTop = panel.scrollHeight
  }, [conversationId, history.data, turns])

  const handleAsk = async () => {
    const text = question.trim()
    if (!text || creating || pending || deleting || (conversationId && !history.data)) return

    let id = conversationId
    if (!id) {
      try {
        const conversation = await useChatStore.getState().createConversation()
        if (!conversation) return
        id = conversation.id
        queryClient.setQueryData<ConversationDetail>(historyKey(id), { conversation, messages: [] })
        setSearchParams({ conversation: id })
        void queryClient.invalidateQueries({ queryKey: conversationListKey })
      } catch {
        return
      }
    }
    setQuestion('')
    followLatest.current = true
    await useChatStore.getState().send(id, text)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: historyKey(id) }),
      queryClient.invalidateQueries({ queryKey: conversationListKey }),
    ])
  }

  return (
    <section className="kb-chat-page" aria-label={history.data?.conversation.title ?? '知识问答'}>
      <div
        ref={messages}
        aria-label="会话消息"
        className="kb-chat-transcript"
        onScroll={(event) => {
          const panel = event.currentTarget
          followLatest.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48
        }}
      >
        {conversationId && <>
          {history.isPending && <Spin />}
          {history.isError && (
            <Alert type="error" title="会话历史加载失败" description={history.error.message}
              action={<Button onClick={() => { void history.refetch() }}>重试</Button>} />
          )}
          {saved.map((item) => (
            <MessageBubble key={item.id} role={item.role}>
              {item.role === 'assistant'
                ? (
                  <>
                    <AgentRetrievalDetails steps={item.agent_steps} />
                    <QueryRouteDetails result={item.query_route} />
                    <ContextCheck sufficient={contextByAnswer.get(item.id)} />
                    <VerificationDetails result={item.verify_result} />
                    <CitationList answer={item.content} citations={item.citations ?? []} />
                    <AnswerTrace traceId={item.trace_id} traceUrl={item.trace_url} />
                  </>
                )
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
              {(!turn.answerId || !savedIds.has(turn.answerId)) && (turn.answer || turn.pending || turn.queryRoute || !!turn.agentSteps?.length || turn.traceId || turn.traceUrl) && (
                <MessageBubble role="assistant">
                  <AgentRetrievalDetails steps={turn.agentSteps} />
                  <QueryRouteDetails result={turn.queryRoute} />
                  <ContextCheck sufficient={turn.contextSufficient} />
                  <VerificationDetails result={turn.verifyResult} />
                  {turn.answer
                    ? <CitationList answer={turn.answer} citations={turn.citations ?? []} />
                    : null}
                  {turn.pending && !turn.answerId && (
                    <p role="status">{turn.phase === 'saving' ? '正在保存回答…'
                      : turn.phase === 'verifying' ? '正在校验答案…'
                      : turn.phase === 'streaming' ? '正在流式输出…'
                      : turn.phase === 'generating' ? '正在准备回答…'
                      : '正在规范化查询并检索知识库…'}</p>
                  )}
                  <AnswerTrace traceId={turn.traceId} traceUrl={turn.traceUrl} />
                </MessageBubble>
              )}
              {turn.error && (
                <MessageBubble role="assistant">
                  <Alert type="error" title="回答中断" description={turn.error} />
                </MessageBubble>
              )}
            </div>
          ))}
        </>}
      </div>

      <div className="kb-composer-shell">
        <Input.TextArea
          aria-label="向知识库提问"
          autoSize={{ minRows: 2, maxRows: 6 }}
          className="kb-question-input"
          disabled={creating || deleting}
          maxLength={2000}
          onChange={(event) => setQuestion(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void handleAsk()
            }
          }}
          placeholder="向知识库提问"
          value={question}
          variant="borderless"
        />
        <div className="kb-composer-foot">
          <span>Enter 发送 · Shift + Enter 换行</span>
          <Button
            className="kb-send-button"
            disabled={!question.trim() || pending || deleting || Boolean(conversationId && !history.data)}
            loading={creating}
            onClick={handleAsk}
            type="primary"
          >
            发送
            <ArrowUpOutlined />
          </Button>
        </div>
      </div>

    </section>
  )
}

export default ChatPage
