import type { CSSProperties } from 'react'

import { splitCodeBlocks } from '../lib/code'
import { bullets, paragraphs } from '../lib/text'
import CodeBlock from './CodeBlock'

function emphasis(text: string) {
  return text
    .split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)
    .map((part, index) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : part.startsWith('`') && part.endsWith('`') ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    )
}

/**
 * Researcher-written text as the participant sees it. Prose becomes
 * paragraphs, a paragraph of "- " lines a bulleted list; anything between a
 * line of ``` and the next is a numbered code window. `mode` says how the
 * prose is laid out: split on blank lines into paragraphs, or kept as written
 * — the latter for the popups on the case screen, which have always shown
 * their text with its line breaks.
 */
export default function StudyText({
  text,
  className,
  style,
  mode = 'paragraphs',
  startLine = 1,
  restartCodeBlocks = false,
  layout,
}: {
  text: string
  className?: string
  style?: CSSProperties
  mode?: 'paragraphs' | 'preserve'
  startLine?: number
  restartCodeBlocks?: boolean
  /** A shared task stimulus can place its prose beside its single code window. */
  layout?: 'stimulus'
}) {
  const segments = splitCodeBlocks(text)
  let nextLine = Number.isSafeInteger(startLine) && startLine > 0 ? startLine : 1
  const numbered = segments.map((segment) => {
    const firstLine = restartCodeBlocks ? 1 : nextLine
    if (segment.kind === 'code') nextLine += segment.lines.length
    return { segment, firstLine }
  })
  const content = numbered.map(({ segment, firstLine }, i) => {
    if (segment.kind === 'code')
      return <CodeBlock key={i} code={segment.lines} lang={segment.lang} startLine={firstLine} />
    const prose =
      mode === 'preserve' ? (
        <p key={i} className={className} style={{ whiteSpace: 'pre-wrap', ...style }}>
          {emphasis(segment.text.replace(/^\n+|\n+$/g, ''))}
        </p>
      ) : (
        paragraphs(segment.text).map((paragraph, j) => {
          const items = bullets(paragraph)
          return items ? (
            <ul key={`${i}-${j}`} className={cx('prose-list', className)} style={style}>
              {items.map((item, k) => (
                <li key={k}>{emphasis(item)}</li>
              ))}
            </ul>
          ) : (
            <p
              key={`${i}-${j}`}
              className={cx(
                className,
                layout === 'stimulus' && /„[^“]+“/.test(paragraph)
                  ? 'study-stimulus__quotation'
                  : undefined,
              )}
              style={style}
            >
              {emphasis(paragraph)}
            </p>
          )
        })
      )
    return layout === 'stimulus' ? (
      <div key={i} className="study-stimulus__prose">
        {prose}
      </div>
    ) : (
      prose
    )
  })
  return layout === 'stimulus' ? (
    <div
      className={cx(
        'study-stimulus',
        segments.filter((s) => s.kind === 'code').length === 1
          ? 'study-stimulus--with-code'
          : undefined,
      )}
    >
      {content}
    </div>
  ) : (
    <>{content}</>
  )
}

function cx(...names: (string | undefined)[]): string {
  return names.filter(Boolean).join(' ')
}
