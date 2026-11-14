/**
 * Real AI video (Veo) through the user's own Gemini subscription.
 *
 * Gemini AI Plus / Pro include Veo in the Gemini app, not in the API key, so
 * JARVIS uses the app the way the user would: in a normal Chrome window of
 * his own (profile ~/.jarvis/gemini-profile) where the user signed in once —
 * Google refuses sign-in in an automation-launched browser, so Chrome is
 * started as itself, with a local debugging port (9333) JARVIS attaches to.
 *
 *   Tools → "Create video" → aspect (Portrait 9:16 / Landscape 16:9) → the
 *   prompt → wait for the <video> (1–4 minutes) → download it with the
 *   window's own login.
 *
 * One at a time; each uses one of the plan's daily video generations.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = 9333
const PROFILE = join(homedir(), '.jarvis', 'gemini-profile')
const APP = 'https://gemini.google.com/app'
const CHROME = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].find((p) => existsSync(p))

/** The daily (or plan) limit is used up: callers fall back to stills. */
export class VideoLimitError extends Error {}

const up = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

/** JARVIS's Gemini window: start it if it isn't running (minimised when just for work). */
async function ensureChrome({ show = false, url = APP } = {}) {
  if (await up()) return
  if (!CHROME) throw new Error('Google Chrome is not installed.')
  spawn(
    CHROME,
    [
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Keep working while minimised or covered.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      ...(show ? ['--start-maximized'] : ['--start-minimized']),
      url,
    ],
    { detached: true, stdio: 'ignore', windowsHide: false },
  ).unref()
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await up()) return
  }
  throw new Error("Couldn't start JARVIS's Gemini window.")
}

async function connect() {
  const { chromium } = await import('playwright-core')
  return chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
}

/** Open JARVIS's Gemini window for the user to sign in (a normal Chrome, so Google allows it). */
export async function openGeminiLogin() {
  if (await up()) {
    const b = await connect()
    try {
      const ctx = b.contexts()[0]
      const p = await ctx.newPage()
      await p.goto(APP).catch(() => {})
      await p.bringToFront().catch(() => {})
    } finally {
      await b.close().catch(() => {})
    }
    return
  }
  await ensureChrome({ show: true })
}

const signedIn = (page) =>
  page.evaluate(
    () => !!document.querySelector('rich-textarea') && ![...document.querySelectorAll('a,button')].some((e) => /^\s*sign in\s*$/i.test(e.textContent || '')),
  )

/** Open the tools menu and choose "Create video" (also looked for under "More tools"). */
async function pickCreateVideo(page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      await page.keyboard.press('Escape').catch(() => {})
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('rich-textarea .ql-editor', { timeout: 30_000 }).catch(() => {})
      await page.waitForTimeout(2500)
    }
    await page.getByRole('button', { name: 'Upload & tools' }).click({ timeout: 20_000 })
    const create = page.getByRole('menuitemcheckbox', { name: /create video/i })
    try {
      await create.first().waitFor({ state: 'visible', timeout: 10_000 })
    } catch {
      const more = page.getByRole('menuitem', { name: /more tools/i })
      if (await more.count()) {
        await more.first().click().catch(() => {})
        await create.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
      }
    }
    if (await create.count()) {
      // The item shows enabled at first and is greyed a moment later, once
      // Gemini has checked the plan's allowance: let it settle.
      await page.waitForTimeout(1500)
      const limit = () =>
        new VideoLimitError(
          "Gemini's \"Create video\" is greyed out — today's video allowance on the Gemini plan is used up; it comes back after Google's daily reset.",
        )
      if ((await create.first().getAttribute('aria-disabled')) === 'true') {
        await page.keyboard.press('Escape').catch(() => {})
        throw limit()
      }
      await create.first().click({ timeout: 5_000 }).catch(() => {})
      // Video mode is on when its aspect-ratio switch appears.
      const on = await page
        .getByRole('button', { name: /Aspect ratio/ })
        .first()
        .waitFor({ state: 'visible', timeout: 6_000 })
        .then(() => true, () => false)
      if (on) return
      const greyed = (await create.first().getAttribute('aria-disabled').catch(() => null)) === 'true'
      await page.keyboard.press('Escape').catch(() => {})
      if (greyed) throw limit()
      console.log(`[jarvis] Gemini didn't switch to video mode (try ${attempt + 1})`)
      continue
    }
    console.log(`[jarvis] Gemini's "Create video" not in the menu (try ${attempt + 1})`)
  }
  throw new Error('Gemini shows no "Create video" tool right now.')
}

let busy = Promise.resolve()

/**
 * One Veo clip from a prompt, saved to `out` (MP4, with Veo's sound). Throws
 * VideoLimitError when the plan's limit is reached, Error otherwise.
 */
export function geminiVideo(prompt, { aspect = '9:16', out, onStatus = () => {} } = {}) {
  const run = busy.then(() => makeVideo(prompt, aspect, out, onStatus))
  busy = run.catch(() => {})
  return run
}

async function makeVideo(prompt, aspect, out, onStatus) {
  await ensureChrome()
  const b = await connect()
  let page
  try {
    const ctx = b.contexts()[0]
    page = await ctx.newPage()
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForSelector('rich-textarea .ql-editor', { timeout: 30_000 }).catch(() => {})
    if (!(await signedIn(page).catch(() => false))) {
      throw new Error('Not signed in to Gemini in my window yet. Say "log in to Gemini" and sign in once.')
    }

    // Tools → Create video. A window that has only just started (minimised)
    // can be slow to fill the menu, so wait for it; failing that, reload once.
    await pickCreateVideo(page)

    // Portrait for reels, landscape otherwise.
    const want = aspect === '16:9' ? 'Landscape (16:9)' : 'Portrait (9:16)'
    const ratio = page.getByRole('button', { name: /Aspect ratio/ })
    if ((await ratio.count()) && !((await ratio.first().getAttribute('aria-label')) ?? '').includes(want)) {
      await ratio.first().click()
      await page.getByRole('menuitemradio', { name: want }).click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(600)
    }
    // A menu left open (its backdrop) would swallow the click on the prompt box.
    for (let i = 0; i < 3 && (await page.locator('.cdk-overlay-backdrop-showing').count()); i++) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }
    const picked = (await ratio.first().getAttribute('aria-label').catch(() => '')) ?? ''
    if (picked && !picked.includes(want)) console.log(`[jarvis] Gemini aspect is "${picked}", wanted ${want}`)

    await page.locator('rich-textarea .ql-editor').click()
    await page.keyboard.type(prompt.replace(/\s+/g, ' ').slice(0, 1500))
    await page.keyboard.press('Enter')
    onStatus('Gemini is making the video…')

    // Wait for the video. The reply text can say "something went wrong" and
    // still deliver the clip, so only the video — or a clear limit — ends it.
    const t0 = Date.now()
    let limitSince = 0
    while (Date.now() - t0 < 9 * 60_000) {
      await page.waitForTimeout(4000)
      const state = await page.evaluate(() => {
        const vid = [...document.querySelectorAll('model-response video, video')].pop()
        const src = vid ? vid.currentSrc || vid.src || vid.querySelector('source')?.src || '' : ''
        const said = ([...document.querySelectorAll('model-response')].pop()?.textContent || '').replace(/\s+/g, ' ').trim()
        return { src, said }
      })
      if (state.src && /^https?:/.test(state.src)) {
        const r = await ctx.request.get(state.src, { timeout: 180_000 })
        if (!r.ok()) throw new Error(`Couldn't download the video (HTTP ${r.status()}).`)
        writeFileSync(out, await r.body())
        return { file: out, seconds: Math.round((Date.now() - t0) / 1000) }
      }
      if (/(reached|hit|used up|exceeded).{0,40}(limit|quota)|limit.{0,30}(reached|today|tomorrow)|come back (later|tomorrow)|can't (create|generate|make) (more|any more) videos/i.test(state.said)) {
        limitSince ||= Date.now()
        if (Date.now() - limitSince > 20_000) throw new VideoLimitError(`Gemini says: ${state.said.slice(0, 200)}`)
      }
    }
    throw new Error('Gemini took longer than 9 minutes to make the video.')
  } finally {
    await page?.close().catch(() => {})
    await b.close().catch(() => {}) // disconnects only; the window stays
  }
}

// ================================================================== Google Flow
//
// Flow (flow.google.com) makes the same kind of video from the plan's monthly
// AI credits (about 12 a clip on Omni 1.2 Flash; 250 a month on AI Plus), so
// it carries on when the Gemini app's few daily videos are used up. Same
// window and login. JARVIS keeps one Flow project of his own; its agent box
// takes "Create a video: ...", and the finished clip appears as a new tile.

const FLOW = 'https://flow.google.com/'
const FLOW_STATE = join(homedir(), '.jarvis', 'flow.json')

const readFlow = () => {
  try {
    return JSON.parse(readFileSync(FLOW_STATE, 'utf8'))
  } catch {
    return {}
  }
}
const saveFlow = (s) => writeFileSync(FLOW_STATE, JSON.stringify(s, null, 2))

/** Menus left open leave a backdrop that swallows clicks; Escape doesn't close Flow's. */
async function clearFlowOverlays(page) {
  for (let i = 0; i < 4; i++) {
    const bd = page.locator('.cdk-overlay-backdrop-showing')
    if (!(await bd.count())) return
    await bd.last().click({ force: true, position: { x: 5, y: 5 } }).catch(() => {})
    await page.waitForTimeout(400)
  }
}

/** One-off notices ("Introducing ..." then Get started). */
async function dismissFlowNotices(page) {
  for (const name of ['Get started', 'Got it', 'Dismiss']) {
    const b = page.getByRole('button', { name, exact: true })
    if (await b.count()) await b.first().click({ timeout: 3000 }).catch(() => {})
  }
}

/** JARVIS's Flow project, open in a new tab (made the first time). */
async function openFlowProject(ctx) {
  const state = readFlow()
  const page = await ctx.newPage()
  if (state.project) {
    await page.goto(state.project, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(4000)
    if (!page.url().includes('/project/')) state.project = null
  }
  if (!state.project) {
    await page.goto(FLOW, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(4000)
    if (/accounts\.google\.com/.test(page.url())) throw new Error('Not signed in to Google in my window. Say "log in to Gemini" and sign in once.')
    await dismissFlowNotices(page)
    await page.getByRole('button', { name: /New project/i }).first().click({ timeout: 20_000 })
    await page.waitForURL(/\/project\//, { timeout: 30_000 })
    state.project = page.url().split('?')[0]
    state.configured = null
    saveFlow(state)
    await page.waitForTimeout(3000)
  }
  await dismissFlowNotices(page)
  await clearFlowOverlays(page)
  return { page, state }
}

/** The project's agent: never ask before spending credits; one clip; the aspect. */
async function configureFlow(page, state, aspect) {
  const want = aspect === '16:9' ? '16:9' : '9:16'
  if (state.configured === want) return
  await page.locator('button:has-text("tune")').first().click({ timeout: 15_000 })
  await page.getByText('Agent settings', { exact: true }).first().waitFor({ timeout: 10_000 })
  await page.locator('label:has-text("Never")').first().click({ timeout: 5000 })
  // The image section comes first; the video section's controls are the last ones.
  await page.locator(`button[role="radio"]:has-text("${want}")`).last().click({ timeout: 5000 })
  await page.locator('button[role="radio"]').filter({ hasText: /^\s*x1\s*$/ }).last().click({ timeout: 3000 }).catch(() => {})
  await page.getByRole('button', { name: 'Save' }).click({ timeout: 5000 })
  await page.waitForTimeout(1200)
  state.configured = want
  saveFlow(state)
}

const thumbs = (page) =>
  page.evaluate(() => [...document.querySelectorAll('img[alt="Generated video thumbnail"]')].map((i) => i.src).filter(Boolean))

/**
 * One clip through Google Flow, saved to `out` (MP4 with sound). Throws
 * VideoLimitError when the credits are used up, Error otherwise.
 */
export function flowVideo(prompt, { aspect = '9:16', out } = {}) {
  const run = busy.then(() => makeFlowVideo(prompt, aspect, out))
  busy = run.catch(() => {})
  return run
}

async function makeFlowVideo(prompt, aspect, out) {
  await ensureChrome()
  const b = await connect()
  let page
  try {
    const ctx = b.contexts()[0]
    const p = await openFlowProject(ctx)
    page = p.page
    await configureFlow(page, p.state, aspect)
    await clearFlowOverlays(page)

    const before = new Set(await thumbs(page))
    const box = page.locator('[role="textbox"][aria-label="What do you want to create?"]')
    await box.first().click({ timeout: 15_000 })
    await page.keyboard.type(`Create a video: ${prompt.replace(/\s+/g, ' ').slice(0, 1500)}`)
    await page.getByRole('button', { name: 'Start generation' }).click({ timeout: 10_000 })

    const t0 = Date.now()
    let saidSince = 0
    while (Date.now() - t0 < 12 * 60_000) {
      await page.waitForTimeout(5000)
      // Tiles are newest first. A new tile's thumbnail link plus "=mm,22,15"
      // is its video — served only once the clip is finished, so keep asking
      // until the answer really is a video.
      const fresh = (await thumbs(page)).find((s) => !before.has(s))
      if (fresh) {
        const r = await ctx.request.get(`${fresh}=mm,22,15`, { timeout: 180_000 }).catch(() => null)
        if (r?.ok() && /video/.test(r.headers()['content-type'] ?? '')) {
          writeFileSync(out, await r.body())
          return { file: out, seconds: Math.round((Date.now() - t0) / 1000), by: 'Flow' }
        }
        continue
      }
      // What the agent says, for credits running out or a refusal.
      const said = await page.evaluate(() => {
        const t = document.body.innerText
        const i = t.lastIndexOf('What do you want to create?')
        return t.slice(Math.max(0, i - 600), i).replace(/\s+/g, ' ')
      })
      if (/(not enough|out of|run out of|insufficient|no more).{0,20}credits/i.test(said)) {
        throw new VideoLimitError('Google Flow credits for this month are used up.')
      }
      if (/(couldn't|could not|can't|cannot|unable to) (generate|create|make)|violat|policy|blocked/i.test(said)) {
        saidSince ||= Date.now()
        if (Date.now() - saidSince > 30_000) throw new Error(`Flow says: ${said.slice(-240)}`)
      }
    }
    throw new Error('Flow took longer than 12 minutes to make the video.')
  } finally {
    await page?.close().catch(() => {})
    await b.close().catch(() => {})
  }
}

/** Google Flow's credit balance ({credits: 238, resets: "Nov 23 at 6:23 PM"}), or null. */
export async function flowCredits() {
  if (!(await up())) return null
  const b = await connect()
  let page
  try {
    page = await b.contexts()[0].newPage()
    await page.goto(FLOW, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(3500)
    await page.locator('[aria-label="Account details"]').first().click({ timeout: 8000 })
    await page.waitForTimeout(2000)
    const t = await page.evaluate(() => document.body.innerText)
    const m = /(\d[\d,]*)\s+Google Flow credits[\s\S]{0,40}?Resets\s+([^\n]+)/i.exec(t)
    return m ? { credits: Number(m[1].replace(/,/g, '')), resets: m[2].trim() } : null
  } catch {
    return null
  } finally {
    await page?.close().catch(() => {})
    await b.close().catch(() => {})
  }
}

/**
 * Real AI video from the user's Google plan. Google Flow first — the user's
 * choice for every video — and the Gemini app's few daily videos only if Flow
 * can't (credits used up, or Flow failing). VideoLimitError only when both
 * are used up.
 */
export async function planVideo(prompt, { aspect = '9:16', out } = {}) {
  let flowErr
  try {
    return await flowVideo(prompt, { aspect, out })
  } catch (err) {
    flowErr = err
    console.log(`[jarvis] Google Flow video unavailable (${String(err.message).split('\n')[0]}) - trying the Gemini app`)
  }
  try {
    return { ...(await geminiVideo(prompt, { aspect, out })), by: 'Gemini' }
  } catch (err) {
    if (err instanceof VideoLimitError && flowErr instanceof VideoLimitError) {
      throw new VideoLimitError("Google Flow's credits and the Gemini app's daily videos are both used up.")
    }
    // Report Flow's problem: it is the one the user relies on.
    throw err instanceof VideoLimitError ? flowErr : err
  }
}
