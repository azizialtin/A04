/** Blank-line separated text as paragraphs, so a researcher can write more than one. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/**
 * The items of a paragraph written as a list — every line starting with "- " —
 * or null when it is ordinary prose. An instrument's bullet points survive the
 * trip through a text field this way.
 */
export function bullets(paragraph: string): string[] | null {
  const lines = paragraph.split('\n').map((l) => l.trim())
  if (!lines.length || !lines.every((l) => l.startsWith('- '))) return null
  return lines.map((l) => l.slice(2).trim())
}
