import { useId, useState } from 'react'
import { CaretRightOutlined } from '@ant-design/icons'
import { Button, Tag, theme } from 'antd'
import type { CitationRead } from '@/client/types.gen'
import type { Element, Root } from 'hast'

import MarkdownComponents from './MarkdownComponents'

export interface CitationItem {
  ordinal: number
  document_name: string
  page_no?: number | null
  section_path?: string | null
  quote: string
  retrieval_meta?: CitationRead['retrieval_meta']
}

export interface CitationListProps {
  answer: string
  citations: readonly CitationItem[]
}

/** 只转换 Markdown 渲染树里的文本，避免改写代码或嵌套链接。 */
function linkCitations(parent: Root | Element, hashes: ReadonlyMap<string, string>) {
  parent.children = parent.children.flatMap<Root['children'][number]>((node) => {
    if (node.type === 'element' && !['a', 'code', 'pre'].includes(node.tagName)) {
      linkCitations(node, hashes)
    }
    if (node.type !== 'text') return [node]

    return node.value.split(/(\[\d+\])/g).filter(Boolean).map((part) => {
      const href = hashes.get(part)
      return href
        ? { type: 'element', tagName: 'a', properties: { href }, children: [{ type: 'text', value: part }] }
        : { type: 'text', value: part }
    })
  }) as typeof parent.children
}

/** 渲染带来源角标的答案，按后端引用序号展开原文。 */
export default function CitationList({ answer, citations }: CitationListProps) {
  const panelId = `citation-${useId()}`
  const { token } = theme.useToken()
  const [activeOrdinal, setActiveOrdinal] = useState<number | null>(null)
  const byHash = new Map(citations.map((citation) => [`#${panelId}-${citation.ordinal}`, citation]))
  const hashes = new Map(citations.map(({ ordinal }) => [`[${ordinal}]`, `#${panelId}-${ordinal}`]))
  const toggleCitation = (ordinal: number) => {
    setActiveOrdinal((current) => current === ordinal ? null : ordinal)
  }

  return (
    <div>
      <MarkdownComponents
        rehypePlugins={[() => (tree: Root) => linkCitations(tree, hashes)]}
        links={({ node: _node, href, children, ...props }) => {
          const citation = href ? byHash.get(href) : undefined
          if (!citation) return <a {...props} href={href}>{children}</a>

          const expanded = activeOrdinal === citation.ordinal
          return (
            <sup>
              <a
                href={href}
                aria-controls={`${panelId}-${citation.ordinal}`}
                aria-expanded={expanded}
                aria-label={`引用 ${citation.ordinal}`}
                onClick={(event) => {
                  event.preventDefault()
                  toggleCitation(citation.ordinal)
                }}
                style={{ color: token.colorPrimaryText, paddingInline: 3 }}
              >
                {children}
              </a>
            </sup>
          )
        }}
      >
        {answer}
      </MarkdownComponents>
      {citations.length > 0 && (
        <section aria-label="引用文档" style={{ marginBlockStart: 12 }}>
          <strong>引用文档</strong>
          {citations.map((citation) => {
            const id = `${panelId}-${citation.ordinal}`
            const expanded = activeOrdinal === citation.ordinal
            const sources = citation.retrieval_meta?.sources ?? []
            const vector = sources.includes('vector')
            const keyword = sources.includes('keyword')
            const retrievalLabel = vector && keyword ? '混合' : vector ? '向量' : keyword ? '关键字' : ''
            const location = [
              citation.page_no != null ? `第 ${citation.page_no} 页` : '',
              citation.section_path,
            ].filter(Boolean).join(' · ')

            return (
              <div key={citation.ordinal} style={{ marginBlockStart: 6 }}>
                <Button
                  aria-controls={id}
                  aria-expanded={expanded}
                  icon={<CaretRightOutlined rotate={expanded ? 90 : 0} />}
                  onClick={() => toggleCitation(citation.ordinal)}
                  style={{ height: 'auto', whiteSpace: 'normal', textAlign: 'start', maxWidth: '100%' }}
                  type="text"
                >
                  [{citation.ordinal}] {citation.document_name}
                </Button>
                {retrievalLabel && <Tag>{retrievalLabel}</Tag>}
                <section
                  aria-label={`引用 ${citation.ordinal} 原文`}
                  hidden={!expanded}
                  id={id}
                  style={{
                    background: token.colorFillAlter,
                    borderInlineStart: `2px solid ${token.colorPrimaryBorder}`,
                    marginBlockStart: 4,
                    overflowWrap: 'anywhere',
                    padding: '12px 16px',
                  }}
                >
                  {expanded && (
                    <>
                      {location && <div style={{ color: token.colorTextSecondary }}>{location}</div>}
                      <MarkdownComponents>{citation.quote}</MarkdownComponents>
                    </>
                  )}
                </section>
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}
