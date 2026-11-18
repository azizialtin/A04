import { codeLines, splitCodeBlocks, studyCodeLineCount, tokenise, type Token } from './code'

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

test('marked JSON code arrays become Java blocks with blank lines, indentation and escaping intact', () => {
  const source = [
    '',
    'public class Heizung {',
    '',
    '\tprivate int temperatur;',
    '    String text = "a ] bracket and \\"quoted\\" word";',
    '    String path = "C:\\\\temp";',
    '    System.out.println("\\n");',
    '}',
    '',
  ]
  const text = `Aufgabe der Schüler:innen\n\nGegebener Code (JSON-Format):\n\nCodeblock 1:\n${JSON.stringify(source, null, 2)}\n\nWelche Ausgabe entsteht?`
  const segments = splitCodeBlocks(text)
  expect(segments.map((segment) => segment.kind)).toEqual(['prose', 'prose', 'code', 'prose'])
  expect(segments[0]).toEqual({ kind: 'prose', text: 'Aufgabe der Schüler:innen\n' })
  expect(segments[1]).toEqual({ kind: 'prose', text: 'Gegebener Code:\n\nCodeblock 1:' })
  expect(segments[2]).toEqual({ kind: 'code', lang: 'java', lines: source })
  expect(segments[3]).toEqual({ kind: 'prose', text: '\nWelche Ausgabe entsteht?' })
  expect(studyCodeLineCount(text)).toBe(source.length)
})

test('multiple marked JSON blocks and Markdown blocks coexist with continuous physical line counts', () => {
  const text = [
    '```java',
    'int vorher = 1;',
    '```',
    'Gegebener Code (JSON-Format):',
    '',
    'Codeblock 1:',
    JSON.stringify(['public class Heizung {\n    int temperatur;\n}']),
    '',
    'Codeblock 2:',
    '',
    JSON.stringify(['', 'Heizung h = new Heizung();', '']),
    '',
    'Danach bleibt dieser Text unverändert.',
    '```java',
    'int nachher = 2;',
    '```',
  ].join('\r\n')
  expect(splitCodeBlocks(text).filter((segment) => segment.kind === 'code')).toEqual([
    { kind: 'code', lang: 'java', lines: ['int vorher = 1;'] },
    { kind: 'code', lang: 'java', lines: ['public class Heizung {', '    int temperatur;', '}'] },
    { kind: 'code', lang: 'java', lines: ['', 'Heizung h = new Heizung();', ''] },
    { kind: 'code', lang: 'java', lines: ['int nachher = 2;'] },
  ])
  expect(studyCodeLineCount(text)).toBe(8)
})

test.each([
  'Codeblock 1:\n["int x;"]',
  'An unrelated JSON example:\n["int x;"]',
  'Gegebener Code (JSON-Format):\n\n["int x;"]',
  'Gegebener Code (JSON-Format):\n\nCodeblock 1:\n["int x;",]',
  'Gegebener Code (JSON-Format):\n\nCodeblock 1:\n["int x;", 2]',
  'Gegebener Code (JSON-Format):\n\nCodeblock 1:\n[["int x;"]]',
  'Gegebener Code (JSON-Format):\n\nCodeblock 1:\n[]',
  'Gegebener Code (JSON-Format):\n\nCodeblock 1:\n["int x;"] trailing prose',
  'Gegebener Code (JSON-Format):\n\nCodeblock 1:\n[\n"unterminated',
])('unmarked, malformed or unrelated JSON stays unchanged: %s', (text) => {
  expect(splitCodeBlocks(text)).toEqual([{ kind: 'prose', text }])
})

test('a malformed second JSON code block remains visible after a valid first block', () => {
  const malformed = '\nCodeblock 2:\n["int y;",]\nUnveränderte Hinweise.'
  const text = `Gegebener Code (JSON-Format):\nCodeblock 1:\n["int x;"]\n${malformed}`
  const segments = splitCodeBlocks(text)
  expect(segments[1]).toEqual({ kind: 'code', lang: 'java', lines: ['int x;'] })
  expect(segments[2]).toEqual({ kind: 'prose', text: malformed })
})

test('code lines come from a list or from a string, trimmed of blank edges', () => {
  expect(codeLines(['', 'int a;', '  int b;', ''])).toEqual(['int a;', '  int b;'])
  expect(codeLines('\nint a;\r\n  int b;\n')).toEqual(['int a;', '  int b;'])
})

test('a multiline array entry still gives each physical code line its own number', () => {
  expect(codeLines(['int a;\r\nint b;', '', 'return a + b;'])).toEqual([
    'int a;',
    'int b;',
    '',
    'return a + b;',
  ])
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
