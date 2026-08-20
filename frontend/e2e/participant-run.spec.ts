import { expect, test } from '@playwright/test'

import { seedStudy } from './seed'

/**
 * A participant walking their run in a real browser.
 *
 * The unit tests check each screen; this checks that they join up — that the
 * step script advances, that what is typed reaches the server, and that the
 * flow reaches the end. The study gets one unrepeatable attempt per person, so
 * "the run got stuck on case four" is the failure worth catching before a
 * participant finds it.
 *
 * There is no eye tracker in CI, so the calibration step takes its documented
 * no-tracker path.
 */
test('a participant works through their cases and reaches the end', async ({ page }) => {
  const { participantId } = await seedStudy(
    process.env.E2E_ADMIN_EMAIL ?? 'e2e@a04.test',
    process.env.E2E_ADMIN_PASSWORD ?? 'e2e-password-1234',
  )

  const failures: string[] = []
  page.on('pageerror', (err) => failures.push(String(err)))

  // --- sign in -------------------------------------------------------------
  await page.goto('/login')
  await page.getByRole('textbox').fill(participantId)
  await page.getByRole('button', { name: 'Anmelden' }).click()

  await expect(page.getByText(participantId)).toBeVisible()
  await page.getByRole('button', { name: 'Los geht’s' }).click()

  // --- the pre-test pages, before anything else ---------------------------
  await expect(page.getByRole('heading', { name: 'Angaben zur Person' })).toBeVisible()
  await expect(page.getByText('Seite 1 von 1')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Weiter' })).toBeDisabled()
  await page.getByRole('spinbutton').fill('34')
  await page.getByRole('button', { name: 'Weiter' }).click()

  // --- the pre-test survey hand-off ---------------------------------------
  await expect(page.getByRole('heading', { name: 'Vorab-Fragebogen' })).toBeVisible()
  await expect(page.getByRole('link')).toHaveAttribute(
    'href',
    `https://sosci.example/pre?id=${participantId}`,
  )
  await page.getByRole('button', { name: /abgeschlossen/ }).click()

  // --- calibration, with no tracker attached ------------------------------
  await expect(page.getByRole('heading', { name: /Kalibrierung/ })).toBeVisible()
  await page.getByRole('button', { name: 'Ohne Eye-Tracking fortfahren' }).click({ timeout: 15_000 })

  // --- two cases -----------------------------------------------------------
  for (const caseNumber of [1, 2]) {
    await expect(page.getByText(`Phase ${caseNumber === 1 ? 1 : 3}`)).toBeVisible()
    await page.getByRole('button', { name: 'Weiter' }).click()

    // Nothing is asked before a case any more — the intro is text only.
    await expect(page.getByRole('heading', { name: 'Neuer Fall' })).toBeVisible()
    await page.getByRole('button', { name: 'Weiter' }).click()

    // The case screen: task on the rail, the two panels, and the notes box.
    await expect(page.getByText(`Diagnostizieren Sie Fall ${caseNumber}`)).toBeVisible()
    await page.getByRole('button', { name: 'Schüler-Aufgabe' }).click()
    await expect(page.getByText('Die Aufgabe der Schüler:innen')).toBeVisible()
    await page.getByRole('button', { name: 'Schließen' }).click()

    const notes = page.getByLabel('Notizen')
    await notes.fill(`Die Schleife läuft einmal zu oft (Fall ${caseNumber})`)
    await notes.blur()
    await page.getByRole('button', { name: 'Weiter' }).click()

    // Diagnosis, with their own notes shown back to them and the confidence
    // rating on the same screen: the write-up alone is not the whole answer.
    await expect(page.getByRole('heading', { name: 'Ihre Diagnose' })).toBeVisible()
    await expect(page.getByText(`Die Schleife läuft einmal zu oft (Fall ${caseNumber})`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Weiter' })).toBeDisabled()
    await page.getByLabel('Was war das Problem?').fill('Der Abbruch der Schleife ist off-by-one.')
    await expect(page.getByRole('button', { name: 'Weiter' })).toBeDisabled()
    await page.getByRole('slider').click()
    await page.getByRole('button', { name: 'Weiter' }).click()

    // The outro: the closing line and the four questions on one screen.
    await expect(page.getByRole('heading', { name: 'Fall abgeschlossen' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Weiter' })).toBeDisabled()
    await page.getByRole('slider').first().click()
    await page.getByRole('slider').last().click()
    for (const statement of [/authentisch/, /Anforderungssituation/]) {
      await page.getByRole('group', { name: statement }).getByRole('radio', { name: '5' }).check()
    }
    await page.getByRole('button', { name: 'Weiter' }).click()

    await expect(page.getByRole('heading', { name: 'Lautes Denken' })).toBeVisible()
    await page.getByRole('button', { name: 'Weiter' }).click()
  }

  // --- the post-test survey, then done ------------------------------------
  await expect(page.getByRole('heading', { name: 'Abschluss-Fragebogen' })).toBeVisible()
  await page.getByRole('button', { name: /abgeschlossen/ }).click()

  await expect(page.getByRole('heading', { name: 'Vielen Dank!' })).toBeVisible()
  expect(failures, `uncaught errors in the browser: ${failures.join('\n')}`).toEqual([])
})

test('a run resumes where it was left', async ({ page, context }) => {
  const { participantId } = await seedStudy(
    process.env.E2E_ADMIN_EMAIL ?? 'e2e@a04.test',
    process.env.E2E_ADMIN_PASSWORD ?? 'e2e-password-1234',
  )

  await page.goto('/login')
  await page.getByRole('textbox').fill(participantId)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await page.getByRole('button', { name: 'Los geht’s' }).click()
  await expect(page.getByRole('heading', { name: 'Angaben zur Person' })).toBeVisible()

  // As if the browser had been closed and reopened mid-session.
  const fresh = await context.newPage()
  await fresh.goto('/session')

  await expect(fresh.getByRole('heading', { name: 'Angaben zur Person' })).toBeVisible()
})

test('an unknown id cannot get in', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('textbox').fill('NOT-A-PARTICIPANT')
  await page.getByRole('button', { name: 'Anmelden' }).click()

  await expect(page.getByText(/Unbekannte Teilnehmer-ID/)).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
})
