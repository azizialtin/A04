import { expect, type Page } from '@playwright/test'

/** Exercise the real new-tab handoff without sending any data to an external survey. */
export async function completeSosci(page: Page) {
  const link = page.getByRole('link', { name: 'Fragebogen öffnen', exact: true })
  const complete = page.getByRole('button', { name: 'Ich habe den Fragebogen abgeschlossen' })
  await expect(complete).toBeDisabled()
  const url = await link.getAttribute('href')
  expect(new URL(url!).hostname).toBe('sosci.example')
  await page
    .context()
    .route(url!, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic survey</h1>' }),
    )
  const opened = page.waitForEvent('popup')
  await link.click()
  const survey = await opened
  await expect(survey.getByRole('heading', { name: 'Synthetic survey' })).toBeVisible()
  await survey.close()
  await page.bringToFront()
  await expect(complete).toBeEnabled()
  await complete.click()
}
