/** Blank-line separated text as paragraphs, so a researcher can write more than one. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}
