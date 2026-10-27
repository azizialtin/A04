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
test('a participant works through their cases and reaches the end', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const { participantId } = await seedStudy(
    process.env.E2E_ADMIN_EMAIL ?? 'e2e@a04.test',
    process.env.E2E_ADMIN_PASSWORD ?? 'e2e-password-1234',
  )

  const failures: string[] = []
  page.on('pageerror', (err) => failures.push(String(err)))
  const layouts: { screen: string; width: number; height: number; overflow: boolean }[] = []
  const inspectScreen = async (screen: string) => {
    await page.evaluate(() => document.fonts.ready)
    const dimensions = await page.evaluate(() => ({
      width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }))
    layouts.push({
      screen,
      width: dimensions.width,
      height: dimensions.height,
      overflow:
        dimensions.width > dimensions.viewportWidth + 1 ||
        dimensions.height > dimensions.viewportHeight + 1,
    })
    const path = testInfo.outputPath(`${screen}.png`)
    await page.screenshot({ path, fullPage: true, animations: 'disabled' })
    await testInfo.attach(screen, { path, contentType: 'image/png' })
  }

  // --- sign in -------------------------------------------------------------
  await page.goto('/login')
  await page.getByRole('textbox').fill(participantId)
  await page.getByRole('button', { name: 'Anmelden' }).click()

  await expect(page.getByText(participantId)).toBeVisible()
  await inspectScreen('01-welcome')
  await page.getByRole('button', { name: 'Los geht’s' }).click()

  // --- the pre-test pages, before anything else ---------------------------
  await expect(page.getByRole('heading', { name: 'Angaben zur Person' })).toBeVisible()
  await expect(page.getByText('Seite 1 von 1')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Weiter' })).toBeDisabled()
  await page.getByRole('spinbutton').fill('34')
  await inspectScreen('02-questionnaire')
  await page.getByRole('button', { name: 'Weiter' }).click()

  // --- the pre-test survey hand-off ---------------------------------------
  await expect(page.getByRole('heading', { name: 'Vorab-Fragebogen' })).toBeVisible()
  await expect(page.getByRole('link')).toHaveAttribute(
    'href',
    `https://sosci.example/pre?id=${participantId}`,
  )
  await inspectScreen('03-pretest-sosci')
  await page.getByRole('button', { name: /abgeschlossen/ }).click()

  // --- calibration, when this deployment runs its own step ----------------
  // The lab calibrates in Tobii Pro Eye Tracker Manager before the participant
  // sits down, so `CALIBRATION_ENABLED` is off by default and the step is
  // simply absent. The run has to work either way, so wait for whichever
  // screen comes next rather than assuming.
  const calibration = page.getByRole('heading', { name: /Kalibrierung/ })
  await expect(calibration.or(page.getByText('Phase 1'))).toBeVisible()
  if (await calibration.isVisible()) {
    await inspectScreen('04-calibration')
    await page
      .getByRole('button', { name: 'Ohne Eye-Tracking fortfahren' })
      .click({ timeout: 15_000 })
  }

  // --- two cases -----------------------------------------------------------
  for (const caseNumber of [1, 2]) {
    await expect(page.getByText(`Phase ${caseNumber === 1 ? 1 : 3}`)).toBeVisible()
    await inspectScreen(`case-${caseNumber}-01-phase-intro`)
    await page.getByRole('button', { name: 'Weiter' }).click()

    // Nothing is asked before a case any more — the intro is text only.
    await expect(page.getByRole('heading', { name: 'Neuer Fall' })).toBeVisible()
    await inspectScreen(`case-${caseNumber}-02-case-intro`)
    await page.getByRole('button', { name: 'Weiter' }).click()

    // The case screen: task on the rail, the two panels, and the notes box.
    await expect(page.getByText(`Diagnostizieren Sie Fall ${caseNumber}`)).toBeVisible()
    await page.getByRole('button', { name: 'Schüler-Aufgabe' }).click()
    await expect(page.getByText('Die Aufgabe der Schüler:innen')).toBeVisible()
    await inspectScreen(`case-${caseNumber}-03-student-task-modal`)
    await page.getByRole('button', { name: 'Schließen' }).click()

    const notes = page.getByLabel('Notizen')
    await notes.fill(`Die Schleife läuft einmal zu oft (Fall ${caseNumber})`)
    await notes.blur()
    await inspectScreen(`case-${caseNumber}-04-case-video`)
    await page.getByRole('button', { name: 'Weiter' }).click()

    // Diagnosis, with their own notes shown back to them and the confidence
    // rating on the same screen: the write-up alone is not the whole answer.
    await expect(page.getByRole('heading', { name: 'Ihre Diagnose' })).toBeVisible()
    await expect(
      page.getByText(`Die Schleife läuft einmal zu oft (Fall ${caseNumber})`),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Weiter' })).toBeDisabled()
    await page.getByLabel('Was war das Problem?').fill('Der Abbruch der Schleife ist off-by-one.')
    await expect(page.getByRole('button', { name: 'Weiter' })).toBeDisabled()
    await page.getByRole('slider').click()
    await inspectScreen(`case-${caseNumber}-05-diagnosis`)
    await page.getByRole('button', { name: 'Weiter' }).click()

    // The outro: the closing line and the four questions on one screen.
    await expect(page.getByRole('heading', { name: 'Fall abgeschlossen' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Weiter' })).toBeDisabled()
    await inspectScreen(`case-${caseNumber}-06-case-outro-unanswered`)
    await page.getByRole('slider').first().click()
    await page.getByRole('slider').last().click()
    for (const statement of [/authentisch/, /Anforderungssituation/]) {
      await page.getByRole('group', { name: statement }).getByRole('radio', { name: '5' }).check()
    }
    await inspectScreen(`case-${caseNumber}-06-case-outro`)
    await page.getByRole('button', { name: 'Weiter' }).click()

    await expect(page.getByRole('heading', { name: 'Lautes Denken' })).toBeVisible()
    await inspectScreen(`case-${caseNumber}-07-think-aloud`)
    await page.getByRole('button', { name: 'Weiter' }).click()
  }

  // --- the post-test survey, then done ------------------------------------
  await expect(page.getByRole('heading', { name: 'Abschluss-Fragebogen' })).toBeVisible()
  await inspectScreen('05-posttest-sosci')
  await page.getByRole('button', { name: /abgeschlossen/ }).click()

  await expect(page.getByRole('heading', { name: 'Vielen Dank!' })).toBeVisible()
  await inspectScreen('06-thanks')

  // The hand-over: the study manager sends the machine back to the id prompt
  // for the next sitting rather than finding the way there themselves.
  await page.getByRole('button', { name: 'Mit der nächsten Person beginnen' }).click()
  await expect(page.getByLabel('Teilnehmer-ID')).toBeVisible()

  await testInfo.attach('participant-layouts', {
    body: JSON.stringify(layouts, null, 2),
    contentType: 'application/json',
  })
  expect(
    layouts.filter(({ overflow }) => overflow),
    'screens requiring document scrolling',
  ).toEqual([])
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
