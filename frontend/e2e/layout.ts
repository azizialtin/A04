import { expect, type Page } from '@playwright/test'

/** Vertical reading is expected; answers and actions must never need sideways scrolling. */
export async function expectNoHorizontalOverflow(page: Page) {
  await expect(async () => {
    const overflow = await page.evaluate(() => {
      const problems: string[] = []
      if (document.documentElement.scrollWidth > innerWidth + 1) {
        problems.push(`document: ${document.documentElement.scrollWidth} > ${innerWidth}`)
      }
      for (const element of document.querySelectorAll<HTMLElement>(
        'button, input:not([type="hidden"]), select, textarea, a[href], .matrix__scroll, .likert__scale',
      )) {
        const rect = element.getBoundingClientRect()
        if (!rect.width || !rect.height) continue
        const name =
          element.getAttribute('aria-label') ||
          element.textContent?.trim().slice(0, 60) ||
          element.tagName
        if (rect.left < -1 || rect.right > innerWidth + 1)
          problems.push(`${name}: outside viewport`)
        if (
          element.matches('.matrix__scroll, .likert__scale') &&
          element.scrollWidth > element.clientWidth + 1
        ) {
          problems.push(`${name}: options overflow their container`)
        }
      }
      return problems
    })
    expect(overflow).toEqual([])
  }).toPass({ timeout: 3000 })
}
