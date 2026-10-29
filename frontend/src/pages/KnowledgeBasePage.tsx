import { App as AntApp, Button } from 'antd'

import StageHead from '@/components/StageHead'

const STAGE_COPY = {
  eyebrow: '02 / KNOWLEDGE BASES',
  headline: (
    <>
      把相关的文档，
      <br />
      <em>收进同一个知识库。</em>
    </>
  ),
  description:
    '按主题组织资料、限定检索范围，让每一次提问都能找到更准确的上下文。',
} as const

/**
 * 知识库页。
 *
 * 当前展示空状态与使用引导；接入知识库接口后，在这里用 React Query
 * 拉取列表并替换 `kb-empty-card` 即可。
 */
export function KnowledgeBasePage() {
  const { message } = AntApp.useApp()

  const handleCreate = () => {
    message.info('知识库创建功能即将接入。')
  }

  return (
    <section className="kb-stage" aria-labelledby="kb-page-title">
      <StageHead {...STAGE_COPY} />

      <div className="kb-kb-layout">
        <div className="kb-empty-card">
          <div className="kb-empty-visual" aria-hidden="true">
            <span className="kb-sheet kb-sheet-back" />
            <span className="kb-sheet kb-sheet-mid" />
            <span className="kb-sheet kb-sheet-front">
              <i />
              <i />
              <i />
              <i />
            </span>
          </div>
          <div className="kb-empty-copy">
            <span className="kb-mini-label">EMPTY LIBRARY</span>
            <h2>还没有知识库</h2>
            <p>创建第一个知识库，把同一主题的文档放在一起，检索会更聚焦。</p>
            <Button onClick={handleCreate} type="primary">
              新建知识库
            </Button>
          </div>
        </div>

        <aside className="kb-guide">
          <span className="kb-mini-label">HOW IT WORKS</span>
          <ol>
            <li>
              <span className="kb-guide-index">01</span>
              <div>
                <strong>按主题归档</strong>
                <p>把合同、手册或研究资料放进各自的知识库。</p>
              </div>
            </li>
            <li>
              <span className="kb-guide-index">02</span>
              <div>
                <strong>限定检索范围</strong>
                <p>提问时只召回相关知识库，减少无关内容干扰。</p>
              </div>
            </li>
            <li>
              <span className="kb-guide-index">03</span>
              <div>
                <strong>带着出处回答</strong>
                <p>每条结论都能回到原文，方便快速核验。</p>
              </div>
            </li>
          </ol>
          <div className="kb-guide-foot">
            <span aria-hidden="true" className="kb-disabled-dot" />
            文档上传即将开放
          </div>
        </aside>
      </div>

      <footer className="kb-stage-note">
        <span className="kb-note-mark">RAG</span>
        <span>知识库页面是基础布局的一部分，后续可在这里接入文档与索引管理。</span>
      </footer>
    </section>
  )
}

export default KnowledgeBasePage
