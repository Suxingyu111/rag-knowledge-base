import { ArrowUpOutlined } from '@ant-design/icons'
import { App as AntApp, Button, Input } from 'antd'
import { useOutletContext } from 'react-router-dom'

import StageHead from '@/components/StageHead'
import type { WorkspaceOutletContext } from '@/layouts/BasicLayout'

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

/**
 * 知识问答页。
 *
 * 输入框草稿由 `BasicLayout` 通过 `<Outlet context>` 提供，因此从知识库
 * 切回问答时不会丢失；点击顶栏「新建对话」会清空草稿并回到本页。
 */
export function ChatPage() {
  const { message } = AntApp.useApp()
  const { question, setQuestion } = useOutletContext<WorkspaceOutletContext>()

  const handleAsk = () => {
    if (!question.trim()) {
      return
    }

    message.info('问答服务接入后，这里会展示带引用的回答。')
  }

  return (
    <section className="kb-stage" aria-labelledby="kb-page-title">
      <StageHead {...STAGE_COPY} />

      <div className="kb-composer-shell">
        <div className="kb-composer-head">
          <span className="kb-composer-label">向知识库提问</span>
          <span className="kb-offline-state">
            <span aria-hidden="true" className="kb-offline-dot" />
            知识库未连接
          </span>
        </div>
        <Input.TextArea
          aria-label="向知识库提问"
          autoSize={{ minRows: 3, maxRows: 6 }}
          className="kb-question-input"
          onChange={(event) => setQuestion(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey) {
              event.preventDefault()
              handleAsk()
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
            disabled={!question.trim()}
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
