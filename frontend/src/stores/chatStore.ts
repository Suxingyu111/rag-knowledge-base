import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { api } from '@/api/client'
import { streamChat, type ChatStreamCitation } from '@/api/chatStream'
import type { ConversationRead, QueryRouteRead } from '@/client/types.gen'

interface ChatTurn {
  question: string
  answer: string
  queryRoute?: QueryRouteRead
  citations?: ChatStreamCitation[]
  userId?: string
  answerId?: string
  pending: boolean
  error?: string
}

interface ChatState {
  creating: boolean
  turns: Record<string, ChatTurn[]>
  createConversation: (title?: string) => Promise<ConversationRead | undefined>
  send: (conversationId: string, question: string) => Promise<void>
}

interface ConversationIndex {
  conversations: ConversationRead[]
  remember: (conversation: ConversationRead) => void
}

export const useConversationIndex = create<ConversationIndex>()(persist((set) => ({
  conversations: [],
  remember: (conversation) => set(({ conversations }) => ({
    conversations: conversations.some(({ id }) => id === conversation.id)
      ? conversations.map((item) => item.id === conversation.id ? conversation : item)
      : [conversation, ...conversations],
  })),
}), {
  name: 'kb-chat-conversations',
}))

export const useChatStore = create<ChatState>()((set, get) => ({
  creating: false,
  turns: {},
  async createConversation(title) {
    if (get().creating) return undefined
    set({ creating: true })
    try {
      const conversation = await api.post<ConversationRead>('/conversations', { title })
      useConversationIndex.getState().remember(conversation)
      return conversation
    } finally {
      set({ creating: false })
    }
  },
  async send(conversationId, question) {
    const previous = get().turns[conversationId] ?? []
    if (previous.some(({ pending }) => pending)) return

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
              update({ userId: event.user_message_id })
              break
            case 'query_route': {
              const { route, query, rewritten_query, hyde_answer, multi_queries } = event
              update({ queryRoute: { route, query, rewritten_query, hyde_answer, multi_queries } })
              break
            }
            case 'citations':
              update({ citations: event.citations })
              break
            case 'token':
              update({ answer: get().turns[conversationId][index].answer + event.delta })
              break
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
