import { EventStreamContentType, fetchEventSource } from '@microsoft/fetch-event-source'
import type { CitationRead } from '@/client/types.gen'
import { API_BASE_URL, ApiError, resolveApiPath } from './client'

export interface ChatStartEvent {
    type: 'start'
    user_message_id: string
}
// 流式引用来自检索结果，持久化引用 ID 由历史接口提供。
export interface ChatStreamCitation extends Omit<CitationRead, 'id'> {
    section_path: string | null
    score: number
}

export interface ChatCitationsEvent {
    type: 'citations'
    citations: ChatStreamCitation[]
}
export interface ChatTokenEvent {
    type: 'token'
    delta: string
}
export interface ChatEndEvent {
    type: 'end'
    message_id: string
    refused: boolean
}
export interface ChatErrorEvent {
    type: 'error'
    code: string
    message: string
}

export type ChatStreamEvent =
    | ChatStartEvent
    | ChatCitationsEvent
    | ChatTokenEvent
    | ChatEndEvent
    | ChatErrorEvent

export interface StreamChatParams {
    conversationId: string
    question: string
    signal?: AbortSignal
    onEvent: (event: ChatStreamEvent) => void
}

const eventTypes = {
    message_start: 'start',
    citations: 'citations',
    token: 'token',
    message_end: 'end',
    error: 'error',
} as const

/** 通过 onEvent 交付业务事件。取消时正常返回，传输或协议错误时拒绝。 */
export async function streamChat({
    conversationId,
    question,
    signal,
    onEvent,
}: StreamChatParams): Promise<void> {
    if (signal?.aborted) return

    const url = API_BASE_URL + resolveApiPath(
        `/conversations/${encodeURIComponent(conversationId)}/chat`,
    )
    // 使用本地控制器，避免库在调用方长期持有的 signal 上保留监听器。
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    let terminal = false

    try {
        await fetchEventSource(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question }),
            signal: controller.signal,
            openWhenHidden: true,
            async onopen(response) {
                if (!response.ok) {
                    throw new ApiError(`问答请求失败（HTTP ${response.status}）`, {
                        status: response.status,
                        method: 'POST',
                        url,
                    })
                }
                const contentType = response.headers.get('content-type')?.split(';')[0]
                if (contentType?.trim().toLowerCase() !== EventStreamContentType || !response.body) {
                    throw new Error('问答接口未返回有效的 SSE 响应')
                }
            },
            onmessage({ event, data }) {
                // SSE 心跳没有业务事件名。
                if (controller.signal.aborted || terminal || !Object.hasOwn(eventTypes, event)) return

                const type = eventTypes[event as keyof typeof eventTypes]
                const payload = JSON.parse(data)
                if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
                    throw new Error(`无效的问答事件载荷：${event}`)
                }
                terminal = type === 'end' || type === 'error'
                onEvent({ ...payload, type } as ChatStreamEvent)
            },
            onclose() {
                if (!terminal && !controller.signal.aborted) {
                    throw new Error('问答流在收到结束事件前断开')
                }
            },
            onerror(error: unknown) {
                // POST 可能已经写入用户消息，重试会重复提交问题。
                throw error
            },
        })
    } finally {
        signal?.removeEventListener('abort', abort)
    }
}
