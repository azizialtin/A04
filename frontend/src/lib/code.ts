/**
 * Code the researchers put in front of participants: the pupils' Java in the
 * Schüler-Aufgabe popup, a snippet under a pre-test question. Two jobs here.
 *
 * `splitCodeBlocks` finds the code in a block of study text. The convention is
 * the one people already know from chat: a line of three backticks opens a
 * block (optionally followed by a language), another closes it, everything
 * between is code with its indentation kept. A block that is never closed runs
 * to the end — the author plainly meant it as code, and losing it would be
 * worse than over-including.
 *
 * `tokenise` splits lines of Java into keywords, strings, comments and numbers
 * for colouring. It is deliberately small — no generics, no annotations — and
 * every token keeps its text exactly, so the lines read back unchanged with or
 * without the colours.
 */

export interface CodeSegment {
  kind: 'code'
  lang: string
  lines: string[]
}

export interface ProseSegment {
  kind: 'prose'
  text: string
}

export type TextSegment = CodeSegment | ProseSegment

const FENCE_OPEN = /^\s*```[ \t]*([A-Za-z0-9_+-]*)[ \t]*$/
const FENCE_CLOSE = /^\s*```[ \t]*$/

/** Leading and trailing blank lines carry nothing, and would number from 2. */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) start++
  while (end > start && !lines[end - 1].trim()) end--
  return lines.slice(start, end)
}

export function splitCodeBlocks(text: string): TextSegment[] {
  const out: TextSegment[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let prose: string[] = []

  const flushProse = () => {
    const joined = prose.join('\n')
    if (joined.trim()) out.push({ kind: 'prose', text: joined })
    prose = []
  }

  let i = 0
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i])
    if (!open) {
      prose.push(lines[i])
      i++
      continue
    }
    flushProse()
    const lang = open[1].toLowerCase()
    const body: string[] = []
    i++
    while (i < lines.length && !FENCE_CLOSE.test(lines[i])) {
      body.push(lines[i])
      i++
    }
    i++ // past the closing fence, or past the end
    out.push({ kind: 'code', lang, lines: trimBlankEdges(body) })
  }
  flushProse()
  return out
}

/**
 * Code as lines. A question's `code` is written in the admin's JSON, where an
 * array with one entry per line is far easier to type than a string full of
 * `\n`; a string is accepted too. Tabs are kept — the stylesheet sizes them.
 */
export function codeLines(code: string | string[]): string[] {
  // The JSON is typed by hand, so the value may be anything; a number or an
  // object shows as its text rather than taking the page down.
  const lines = Array.isArray(code)
    ? code.map((line) => String(line ?? '').replace(/\r/g, ''))
    : String(code ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
  return trimBlankEdges(lines)
}

export type TokenType = 'kw' | 'str' | 'com' | 'num' | 'plain'

export interface Token {
  type: TokenType
  text: string
}

const JAVA_KEYWORDS = new Set([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'try',
  'var',
  'void',
  'volatile',
  'while',
  'true',
  'false',
  'null',
])

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/
const NUMBER = /^[0-9][0-9A-Za-z_.]*/

/** One line's tokens. `state` carries a block comment across lines. */
function tokeniseLine(line: string, state: { blockComment: boolean }): Token[] {
  const tokens: Token[] = []
  const push = (type: TokenType, text: string) => {
    if (!text) return
    const last = tokens[tokens.length - 1]
    // Runs of plain text and of comment text read as one token; keywords and
    // literals stay their own, so two keywords in a row are coloured apart.
    if (last && last.type === type && (type === 'plain' || type === 'com')) last.text += text
    else tokens.push({ type, text })
  }

  let i = 0
  while (i < line.length) {
    const rest = line.slice(i)

    if (state.blockComment) {
      const end = rest.indexOf('*/')
      if (end === -1) {
        push('com', rest)
        i = line.length
      } else {
        push('com', rest.slice(0, end + 2))
        i += end + 2
        state.blockComment = false
      }
      continue
    }
    if (rest.startsWith('//')) {
      push('com', rest)
      break
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2)
      if (end === -1) {
        push('com', rest)
        state.blockComment = true
        break
      }
      push('com', rest.slice(0, end + 2))
      i += end + 2
      continue
    }

    const ch = rest[0]
    if (ch === '"' || ch === "'") {
      // Java literals end at the line, so an unclosed one cannot eat the rest.
      let j = 1
      while (j < rest.length && rest[j] !== ch) {
        if (rest[j] === '\\') j++
        j++
      }
      const end = Math.min(j + 1, rest.length)
      push('str', rest.slice(0, end))
      i += end
      continue
    }

    const number = NUMBER.exec(rest)
    if (number) {
      push('num', number[0])
      i += number[0].length
      continue
    }
    const ident = IDENT.exec(rest)
    if (ident) {
      push(JAVA_KEYWORDS.has(ident[0]) ? 'kw' : 'plain', ident[0])
      i += ident[0].length
      continue
    }

    push('plain', ch)
    i++
  }
  return tokens
}

/**
 * Tokens per line. Java gets its keywords, strings, comments and numbers told
 * apart; any other language is shown as it is, numbered but uncoloured. A
 * block without a language is taken to be Java, which is what this study has.
 */
export function tokenise(lines: string[], lang = 'java'): Token[][] {
  if (lang && lang !== 'java') return lines.map((line) => [{ type: 'plain', text: line }])
  const state = { blockComment: false }
  return lines.map((line) => tokeniseLine(line, state))
}
