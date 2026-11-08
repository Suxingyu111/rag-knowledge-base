import type { CSSProperties } from 'react'
import { theme } from 'antd'
import ReactMarkdown from 'react-markdown'
import type { Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownComponentsProps {
  children: string
  links?: NonNullable<Options['components']>['a']
  rehypePlugins?: Options['rehypePlugins']
}

/** 渲染 Markdown，并为宽表格提供独立的横向滚动区域。 */
export default function MarkdownComponents({ children, links, rehypePlugins }: MarkdownComponentsProps) {
  const { token } = theme.useToken()
  const cellStyle: CSSProperties = {
    border: `1px solid ${token.colorBorderSecondary}`,
    padding: '6px 12px',
  }

  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      components={{
        ...(links ? { a: links } : {}),
        table: ({ node: _node, ...props }) => (
          <div style={{ overflowX: 'auto' }}>
            <table {...props} style={{ borderCollapse: 'collapse', minWidth: '100%' }} />
          </div>
        ),
        th: ({ node: _node, style, ...props }) => (
          <th {...props} scope="col" style={{ ...style, ...cellStyle, background: token.colorFillAlter }} />
        ),
        td: ({ node: _node, style, ...props }) => (
          <td {...props} style={{ ...style, ...cellStyle }} />
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
