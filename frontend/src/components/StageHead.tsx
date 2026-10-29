import type { ReactNode } from 'react'

export interface StageHeadProps {
  /** 小号英文眉题，例如 `01 / KNOWLEDGE CHAT`。 */
  eyebrow: string
  /** 主标题，允许使用 `<br />` 与 `<em>` 做排版。 */
  headline: ReactNode
  /** 标题下方的一段说明文案。 */
  description: string
}

/**
 * 页面主视觉头部。
 *
 * 所有主页面共用同一套排版结构与 `aria-labelledby` 目标，保证切换路由时
 * 标题层级和样式一致；具体文案由页面在 `routes` 对应的组件中传入。
 */
export default function StageHead({
  description,
  eyebrow,
  headline,
}: StageHeadProps) {
  return (
    <header className="kb-stage-head">
      <p className="kb-kicker">
        <span aria-hidden="true" className="kb-kicker-rule" />
        {eyebrow}
      </p>
      <h1 id="kb-page-title">{headline}</h1>
      <p className="kb-lede">{description}</p>
    </header>
  )
}
