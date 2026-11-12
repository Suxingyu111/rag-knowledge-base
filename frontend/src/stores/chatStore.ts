import { create } from 'zustand'

import { api } from '@/api/client'
import { streamChat, type ChatStreamCitation } from '@/api/chatStream'
import type { AgentStep, ConversationRead, QueryRouteRead, VerifyResultRead } from '@/client/types.gen'

interface ChatTurn {
  question: string
  answer: string
  agentSteps?: AgentStep[]
  phase?: 'generating' | 'verifying' | 'streaming' | 'saving'
  queryRoute?: QueryRouteRead
  contextSufficient?: boolean
  verifyResult?: VerifyResultRead
  citations?: ChatStreamCitation[]
  userId?: string
  answerId?: string
  pending: boolean
  error?: string
}

interface ChatState {
  creating: boolean
  deletingId?: string
  turns: Record<string, ChatTurn[]>
  createConversation: (title?: string) => Promise<ConversationRead | undefined>
  deleteConversation: (id: string) => Promise<boolean>
  send: (conversationId: string, question: string) => Promise<void>
}

export const useChatStore = create<ChatState>()((set, get) => ({
  creating: false,
  turns: {},
  async createConversation(title) {
    if (get().creating) return undefined
    set({ creating: true })
    try {
      return await api.post<ConversationRead>('/conversations', { title })
    } finally {
      set({ creating: false })
    }
  },
  async deleteConversation(id) {
    if (get().deletingId || get().turns[id]?.some(({ pending }) => pending)) return false
    set({ deletingId: id })
    try {
      await api.remove<void>(`/conversations/${encodeURIComponent(id)}`)
      set(({ turns }) => {
        const remaining = { ...turns }
        delete remaining[id]
        return { turns: remaining }
      })
      return true
    } finally {
      set({ deletingId: undefined })
    }
  },
  async send(conversationId, question) {
    const previous = get().turns[conversationId] ?? []
    if (get().deletingId === conversationId || previous.some(({ pending }) => pending)) return

    const index = previous.length
    const update = (patch: Partial<ChatTurn>) => set(({ turns }) => ({
      turns: {
        ...turns,
        [conversationId]: turns[conversationId].map((turn, i) => i === index ? { ...turn, ...patch } : turn),
      },
    }))

    set(({ turns }) => ({
      turns: { ...turns, [conversationId]: [...previous, { question, answer: '', pending: true }] },
    }))

    try {
      await streamChat({
        conversationId,
        question,
        onEvent(event) {
          switch (event.type) {
            case 'start':
              update({ userId: event.user_message_id, phase: 'generating' })
              break
            case 'query_route': {
              const { route, query, rewritten_query, hyde_answer, multi_queries } = event
              update({ queryRoute: { route, query, rewritten_query, hyde_answer, multi_queries } })
              break
            }
            case 'agent_steps':
              update({ agentSteps: event.steps })
              break
            case 'context_check':
              update({ contextSufficient: event.sufficient })
              break
            case 'verifying':
              update({ phase: 'verifying' })
              break
            case 'saving':
              update({ phase: 'saving' })
              break
            case 'citations':
              update({ citations: event.citations })
              break
            case 'token':
              update({ phase: 'streaming', answer: get().turns[conversationId][index].answer + event.delta })
              break
            case 'verify_result': {
              const { verified, reason, replacement_answer } = event
              update({
                verifyResult: { verified, reason },
                ...(verified ? {} : { answer: replacement_answer ?? '', citations: [] }),
              })
              break
            }
            case 'end':
              update({ answerId: event.message_id })
              break
            case 'error':
              update({ error: event.message })
              break
          }
        },
      })
    } catch (error) {
      update({ error: error instanceof Error ? error.message : '问答请求失败' })
    } finally {
      update({ pending: false })
    }
  },
}))
