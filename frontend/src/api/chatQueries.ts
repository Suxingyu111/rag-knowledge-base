export const conversationListKey = ['chat', 'conversations'] as const
export const historyKey = (id: string) => ['chat', 'history', id] as const
