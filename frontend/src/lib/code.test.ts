import { codeLines, splitCodeBlocks, tokenise, type Token } from './code'

const JAVA = [
  'Lies den Code:',
  '',
  '```java',
  'public int max(int[] a) {',
  '    int m = 0;',
  '    for (int i = 0; i <= a.length; i++) {',
  '        if (a[i] > m) m = a[i];',
  '    }',
  '    return m;',
  '}',
  '```',
  '',
  'Was geht schief?',
].join('\n')

test('text with a fenced block becomes prose, code, prose', () => {
  const segments = splitCodeBlocks(JAVA)
  expect(segments.map((s) => s.kind)).toEqual(['prose', 'code', 'prose'])
  expect(segments[0]).toEqual({ kind: 'prose', text: 'Lies den Code:\n' })
  expect(segments[2]).toEqual({ kind: 'prose', text: '\nWas geht schief?' })
  const code = segments[1] as Extract<(typeof segments)[number], { kind: 'code' }>
  expect(code.lang).toBe('java')
  expect(code.lines).toHaveLength(7)
  // Indentation is the point; it must survive untouched.
  expect(code.lines[3]).toBe('        if (a[i] > m) m = a[i];')
})

test('a fence without a language, with stray spaces, and Windows line ends all work', () => {
  const segments = splitCodeBlocks('Vorher\r\n  ``` \r\nint x = 1;\r\n```\r\nNachher')
  expect(segments.map((s) => s.kind)).toEqual(['prose', 'code', 'prose'])
  expect(segments[1]).toEqual({ kind: 'code', lang: '', lines: ['int x = 1;'] })
})

test('blank lines at the edges of a block are dropped so numbering starts at the code', () => {
  const [code] = splitCodeBlocks('```\n\n\nint x = 1;\nint y = 2;\n\n```')
  expect(code).toEqual({ kind: 'code', lang: '', lines: ['int x = 1;', 'int y = 2;'] })
})

test('a block that is never closed runs to the end rather than vanishing', () => {
  const segments = splitCodeBlocks('Text\n```java\nint x = 1;\nint y = 2;')
  expect(segments).toEqual([
    { kind: 'prose', text: 'Text' },
    { kind: 'code', lang: 'java', lines: ['int x = 1;', 'int y = 2;'] },
  ])
})

test('text without a fence is one prose segment, and blank text is none', () => {
  expect(splitCodeBlocks('Nur Text.\n\nZweiter Absatz.')).toEqual([
    { kind: 'prose', text: 'Nur Text.\n\nZweiter Absatz.' },
  ])
  expect(splitCodeBlocks('  \n')).toEqual([])
})

test('code lines come from a list or from a string, trimmed of blank edges', () => {
  expect(codeLines(['', 'int a;', '  int b;', ''])).toEqual(['int a;', '  int b;'])
  expect(codeLines('\nint a;\r\n  int b;\n')).toEqual(['int a;', '  int b;'])
})

test('a code value of the wrong type, as hand-typed JSON can produce, does not throw', () => {
  expect(codeLines(42 as unknown as string)).toEqual(['42'])
  expect(codeLines(null as unknown as string)).toEqual([])
  expect(codeLines([1, null, 'x'] as unknown as string[])).toEqual(['1', '', 'x'])
})

const text = (tokens: Token[]) => tokens.map((t) => t.text).join('')
const types = (tokens: Token[]) => tokens.map((t) => `${t.type}:${t.text}`)

test('java keywords, strings, numbers and comments are told apart, and nothing is lost', () => {
  const lines = [
    'public static void main(String[] args) { // entry',
    '    String s = "a \\"quoted\\" word"; char c = \'x\';',
    '    int n = 0x1F + 10L + 1_000; /* start',
    '       still a comment */ return;',
    '}',
  ]
  const rows = tokenise(lines)

  // Every line reads back exactly, with or without the colours.
  rows.forEach((tokens, i) => expect(text(tokens)).toBe(lines[i]))

  expect(types(rows[0])).toEqual([
    'kw:public',
    'plain: ',
    'kw:static',
    'plain: ',
    'kw:void',
    'plain: main(String[] args) { ',
    'com:// entry',
  ])
  expect(types(rows[1])).toContain('str:"a \\"quoted\\" word"')
  expect(types(rows[1])).toContain("str:'x'")
  expect(types(rows[2])).toContain('num:0x1F')
  expect(types(rows[2])).toContain('num:10L')
  expect(types(rows[2])).toContain('num:1_000')
  expect(types(rows[2])[types(rows[2]).length - 1]).toBe('com:/* start')
  // The block comment carries into the next line and ends there.
  expect(types(rows[3])).toEqual([
    'com:       still a comment */',
    'plain: ',
    'kw:return',
    'plain:;',
  ])
})

test('an unclosed string stops at the end of its line', () => {
  const [first, second] = tokenise(['String s = "open', 'int x = 1;'])
  expect(types(first)).toEqual(['plain:String s = ', 'str:"open'])
  expect(types(second)).toEqual(['kw:int', 'plain: x = ', 'num:1', 'plain:;'])
})

test('a word that merely contains a keyword is not one', () => {
  const [tokens] = tokenise(['int interval = format(classic);'])
  expect(types(tokens)).toEqual(['kw:int', 'plain: interval = format(classic);'])
})

test('another language is shown as it is, uncoloured', () => {
  expect(tokenise(['def f(): return 1'], 'python')).toEqual([
    [{ type: 'plain', text: 'def f(): return 1' }],
  ])
})
