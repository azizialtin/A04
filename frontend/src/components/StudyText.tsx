import type { CSSProperties } from 'react'

import { splitCodeBlocks } from '../lib/code'
import { paragraphs } from '../lib/text'
import CodeBlock from './CodeBlock'

/**
 * Researcher-written text as the participant sees it. Prose becomes
 * paragraphs; anything between a line of ``` and the next is a numbered code
 * window. `mode` says how the prose is laid out: split on blank lines into
 * paragraphs, or kept as written — the latter for the popups on the case
 * screen, which have always shown their text with its line breaks.
 */
export default function StudyText({
  text,
  className,
  style,
  mode = 'paragraphs',
}: {
  text: string
  className?: string
  style?: CSSProperties
  mode?: 'paragraphs' | 'preserve'
}) {
  const segments = splitCodeBlocks(text)
  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === 'code' ? (
          <CodeBlock key={i} code={segment.lines} lang={segment.lang} />
        ) : mode === 'preserve' ? (
          <p key={i} className={className} style={{ whiteSpace: 'pre-wrap', ...style }}>
            {segment.text.replace(/^\n+|\n+$/g, '')}
          </p>
        ) : (
          paragraphs(segment.text).map((paragraph, j) => (
            <p key={`${i}-${j}`} className={className} style={style}>
              {paragraph}
            </p>
          ))
        ),
      )}
    </>
  )
}
