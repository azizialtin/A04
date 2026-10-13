import { Fragment } from 'react'

import { codeLines, tokenise } from '../lib/code'

/**
 * Code as a participant reads it: monospace, indentation kept, a number on
 * every line so an answer can name one, and sideways scrolling instead of
 * wrapped lines that would shift the numbering. The numbers are drawn by the
 * stylesheet rather than written into the text, so copying the block copies
 * the code alone.
 */
export default function CodeBlock({
  code,
  lang = 'java',
}: {
  code: string | string[]
  lang?: string
}) {
  const lines = codeLines(code)
  if (!lines.length) return null
  const rows = tokenise(lines, lang)

  return (
    <pre className="code" tabIndex={0}>
      <code>
        {rows.map((tokens, i) => (
          <span key={i} className="code__line" data-line={i + 1}>
            {tokens.map((token, j) =>
              token.type === 'plain' ? (
                <Fragment key={j}>{token.text}</Fragment>
              ) : (
                <span key={j} className={`tok tok--${token.type}`}>
                  {token.text}
                </span>
              ),
            )}
            {'\n'}
          </span>
        ))}
      </code>
    </pre>
  )
}
