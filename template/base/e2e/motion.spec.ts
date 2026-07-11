import { expect, type Page, test } from '@playwright/test'
import { ROUTES } from '../apps/desktop/src/routes'
import { holdDataRequests, installMockIpc, stubHealthz } from './mock-ipc'

// Reduced-motion doctrine: non-essential motion is opt-in. The app gates its own
// animations behind Tailwind's `motion-safe:` variant (the Skeleton pulse) plus a
// global prefers-reduced-motion backstop in styles.css. This spec proves the
// RUNNING app honors it: with the notes response held so the loading skeleton
// stays on screen, its pulse must be STOPPED under reduced motion and RUN without
// it (the control below proves the reduce assertion can genuinely red).
//
// The media is emulated PER TEST rather than leaning on the lane's ambient
// reducedMotion (each test is then self-contained and unambiguous). The subject
// is a CSS ANIMATION (the pulse) — colour TRANSITIONS fire transiently when the
// theme is applied and the backstop already collapses them to ~0.01ms; those are
// not the perceptible motion the doctrine targets.
// SOURCE: prefers-reduced-motion / WCAG 2.3.3 — non-essential motion is opt-in
// [corpus: wcag/reduced-motion]

// The home route holds a Skeleton loading surface (data-testid = states.loading).
const HOME = ROUTES.find((route) => route.path === '/') ?? ROUTES[0]

/** Count running CSS animations (e.g. the Skeleton's `pulse`), not transitions. */
function runningPulses(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.getAnimations().filter((a) => a instanceof CSSAnimation && a.playState === 'running')
        .length,
  )
}

test('reduced motion: the held loading skeleton runs NO animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installMockIpc(page)
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  await holdDataRequests(page)
  await page.goto(HOME.path)

  // Non-vacuous: the animated element IS on screen — the pulse would be running
  // here if the app did not honor the setting (the control test proves that).
  await expect(page.getByTestId(HOME.states.loading)).toBeVisible()
  expect(
    await runningPulses(page),
    'prefers-reduced-motion must stop the skeleton pulse (expected 0 running animations)',
  ).toBe(0)
})

test('control: WITHOUT reduced motion the same held loading skeleton DOES animate', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await installMockIpc(page)
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  await holdDataRequests(page)
  await page.goto(HOME.path)

  await expect(page.getByTestId(HOME.states.loading)).toBeVisible()
  // Proves the reduced-motion assertion is falsifiable: the motion-safe pulse
  // genuinely runs when motion is allowed, so a 0 under reduce is the app's doing.
  await expect
    .poll(() => runningPulses(page), {
      message: 'the motion-safe pulse must run when motion is allowed',
    })
    .toBeGreaterThan(0)
})
