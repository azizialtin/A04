import { render } from '@testing-library/react'

import CodeBlock from './CodeBlock'

test('numbers every line, including an empty one, and keeps the numbers out of the text', () => {
  const { container } = render(<CodeBlock code={['int a = 1;', '', 'return a;']} />)

  const lines = container.querySelectorAll('.code__line')
  expect(Array.from(lines).map((l) => l.getAttribute('data-line'))).toEqual(['1', '2', '3'])
  // What a copy of the block yields: the code, one line per line.
  expect(container.querySelector('pre')?.textContent).toBe('int a = 1;\n\nreturn a;\n')
})

test('colours java keywords, strings and comments', () => {
  const { container } = render(<CodeBlock code={['return "x"; // done']} />)
  expect(container.querySelector('.tok--kw')?.textContent).toBe('return')
  expect(container.querySelector('.tok--str')?.textContent).toBe('"x"')
  expect(container.querySelector('.tok--com')?.textContent).toBe('// done')
})

test('renders nothing for an empty block', () => {
  const { container } = render(<CodeBlock code={['', '  ']} />)
  expect(container.innerHTML).toBe('')
})

test('an explicit first line continues a snippet without putting numbers in copied code', () => {
  const { container } = render(<CodeBlock code={['return x;', '', '}']} startLine={12} />)
  expect(
    Array.from(container.querySelectorAll('.code__line')).map((l) => l.getAttribute('data-line')),
  ).toEqual(['12', '13', '14'])
  expect(container.querySelector('pre')?.textContent).toBe('return x;\n\n}\n')
})
