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
export function flowVideo(prompt, { aspect = '9:16', out, characters = [] } = {}) {
  const run = busy.then(() => makeFlowVideo(prompt, aspect, out, characters))
  busy = run.catch(() => {})
  return run
}

async function makeFlowVideo(prompt, aspect, out, characters = []) {
  await ensureChrome()
  const b = await connect()
  let page
  try {
    const ctx = b.contexts()[0]
    const p = await openFlowProject(ctx)
    page = p.page
    await configureFlow(page, p.state, aspect)
    await clearFlowOverlays(page)

    // The grid fills in gradually: wait until it stops growing before noting
    // which videos are already there, or an old one appearing late looks new.
    let seen = -1
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1500)
      const n = (await thumbs(page)).length
      if (n === seen) break
      seen = n
    }
    const before = new Set(await thumbs(page))
    // The agent's conversation so far: only what it says after this point is
    // its answer to this request (older turns can hold old errors).
    const agentText = () =>
      page.evaluate(() => {
        const t = document.body.innerText
        return t.slice(0, Math.max(0, t.lastIndexOf('What do you want to create?')))
      })
    const earlier = await agentText()
    // The scene's characters go into the prompt first, so Flow draws them as
    // made; those kept in words (children) are described in the prompt itself.
    const { attach, written } = castFor(characters)
    if (attach.length) await attachCharacters(page, attach)
    const looks = written.map((c) => `${c.name} looks exactly like this in every shot: ${c.description}.`).join(' ')
    const box = page.locator('[role="textbox"][aria-label="What do you want to create?"]')
    await box.first().click({ timeout: 15_000 })
    await page.keyboard.type(`Create a video: ${`${prompt} ${looks}`.replace(/\s+/g, ' ').trim().slice(0, 2500)}`)
    await page.getByRole('button', { name: 'Start generation' }).click({ timeout: 10_000 })

    const t0 = Date.now()
    let saidSince = 0
    while (Date.now() - t0 < 12 * 60_000) {
      await page.waitForTimeout(5000)
      // Tiles are newest first. A new tile's thumbnail link plus "=mm,22,15"
      // is its video — served only once the clip is finished, so keep asking
      // until the answer really is a video.
      // Only the newest tile (Flow lists newest first) can be this request's;
      // anything appearing further down is an older video loading late.
      const list = await thumbs(page)
      for (const s of list.slice(1)) before.add(s)
      const fresh = list[0] && !before.has(list[0]) ? list[0] : null
      if (fresh) {
        const r = await ctx.request.get(`${fresh}=mm,22,15`, { timeout: 180_000 }).catch(() => null)
        if (r?.ok() && /video/.test(r.headers()['content-type'] ?? '')) {
          writeFileSync(out, await r.body())
          return { file: out, seconds: Math.round((Date.now() - t0) / 1000), by: 'Flow' }
        }
        continue
      }
      // What the agent has said since this request, for credits running out
      // or a refusal ("Please edit your prompt and try again").
      const now = await agentText()
      const said = (now.startsWith(earlier.slice(0, 200)) ? now.slice(earlier.length) : now.slice(-600)).replace(/\s+/g, ' ')
      if (/(not enough|out of|run out of|insufficient|no more).{0,20}credits/i.test(said)) {
        throw new VideoLimitError('Google Flow credits for this month are used up.')
      }
      if (/(couldn't|could not|can't|cannot|unable to) (generate|create|make)|violat|policy|blocked|edit your prompt and try again/i.test(said)) {
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
export async function planVideo(prompt, { aspect = '9:16', out, characters = [] } = {}) {
  let flowErr
  try {
    return await flowVideo(prompt, { aspect, out, characters })
  } catch (err) {
    flowErr = err
    // A missing character is a mistake to fix, not a reason to draw the
    // scene without them somewhere else.
    if (/isn't in Flow yet/.test(String(err.message))) throw err
    // The Gemini app can't use Flow's characters, and a scene drawn without
    // them breaks the story's look: stop here instead.
    if (characters.length) throw err
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

// ============================================================ Flow characters
//
// A story's characters, made once and reused in every scene so they look the
// same throughout: each is a picture (from ChatGPT) uploaded as a Flow
// character with its name and personality. Before a scene's prompt, the
// characters in it are attached from the prompt box's ingredients (+ >
// Characters > the name > Add to prompt). Kept in ~/.jarvis/flow.json as
// characters: { "<lower name>": { name, id, description } }.

const keyOf = (name) => String(name).trim().toLowerCase()

/**
 * Flow's character voices (the same 30 voices as Gemini's speech, so a
 * character sounds the same in Flow and in Gemini voiceovers).
 */
export const FLOW_VOICES = {
  Achernar: 'Female, soft, high pitch', Achird: 'Male, friendly, mid pitch', Algenib: 'Male, gravelly, low pitch',
  Algieba: 'Male, easy-going, mid-low pitch', Alnilam: 'Male, firm, mid-low pitch', Aoede: 'Female, breezy, mid pitch',
  Autonoe: 'Female, bright, mid pitch', Callirrhoe: 'Female, easy-going, mid pitch', Charon: 'Male, informative, lower pitch',
  Despina: 'Female, smooth, mid pitch', Enceladus: 'Male, breathy, lower pitch', Erinome: 'Female, clear, mid pitch',
  Fenrir: 'Male, excitable, younger pitch', Gacrux: 'Female, mature, mid pitch', Iapetus: 'Male, clear, mid-low pitch',
  Kore: 'Female, firm, mid pitch', Laomedeia: 'Female, upbeat, mid-high pitch', Leda: 'Female, youthful, mid-high pitch',
  Orus: 'Male, firm, mid-low pitch', Puck: 'Male, upbeat, mid pitch', Pulcherrima: 'Ungendered, forward, mid-high pitch',
  Rasalgethi: 'Male, informative, mid pitch', Sadachbia: 'Male, lively, low pitch', Sadaltager: 'Male, knowledgeable, mid pitch',
  Schedar: 'Male, even, mid-low pitch', Sulafat: 'Female, warm, mid pitch', Umbriel: 'Male, smooth, lower pitch',
  Vindemiatrix: 'Female, gentle, mid pitch', Zephyr: 'Female, bright, mid-high pitch', Zubenelgenubi: 'Male, casual, mid-low pitch',
}

/**
 * A voice that suits a character and that no other character already has:
 * gender from the description, then the age (old → low/gravelly/mature;
 * child → younger/bright/high; young → youthful/upbeat; else firm/warm/clear).
 */
export function pickVoice(description, taken = []) {
  const d = ` ${String(description).toLowerCase()} `
  const female = /\b(woman|women|girl|female|lady|mother|mom|amma|grandmother|grandma|paati|aunt|sister|daughter|queen|princess|she|her)\b/.test(d)
  const age = Number((d.match(/\b(\d{1,2})[- ]?(year|yr)s?[- ]?old\b/) || [])[1]) || null
  // "10-year-old" has the word "old" in it: the age, when given, decides.
  const old = age ? age >= 55 : /\b(old|elderly|aged|grandfather|grandpa|thatha|grandmother|grandma|paati|senior)\b/.test(d)
  const child = age ? age <= 13 : /\b(child|kid|little boy|little girl|toddler|baby|boy|girl)\b/.test(d)
  const young = !child && (age ? age <= 25 : /\b(teen|teenager|young|youth|college)\b/.test(d))
  const prefs = old
    ? [/gravelly|mature|low pitch|lower pitch|even/i]
    : child
      ? [/younger|youthful|high pitch|mid-high|excitable|bright/i]
      : young
        ? [/youthful|upbeat|lively|mid-high|bright|friendly/i]
        : [/firm|warm|clear|friendly|smooth|easy-going/i]
  const fits = Object.entries(FLOW_VOICES).filter(([n, v]) => (female ? /^Female/.test(v) : /^Male/.test(v)) && !taken.includes(n))
  const best = fits.find(([, v]) => prefs[0].test(v)) ?? fits[0] ?? Object.entries(FLOW_VOICES).find(([n]) => !taken.includes(n))
  return best ? best[0] : female ? 'Kore' : 'Charon'
}

/**
 * How a character's voice is described in a prompt, with their age so the
 * voice sounds as old as they look: "an elderly man's gravelly, low pitch
 * voice", "a young boy's excitable, younger pitch voice".
 */
export function voiceLine(c) {
  const v = FLOW_VOICES[c?.voice]
  if (!v) return ''
  const d = ` ${String(c.description ?? '').toLowerCase()} `
  const female = /^Female/.test(v)
  const age = Number((d.match(/\b(\d{1,2})[- ]?(year|yr)s?[- ]?old\b/) || [])[1]) || null
  const old = age ? age >= 55 : /\b(old|elderly|aged|grandfather|grandpa|thatha|grandmother|grandma|paati|senior)\b/.test(d)
  const child = age ? age <= 13 : /\b(child|kid|toddler|baby|little boy|little girl)\b/.test(d)
  const young = !child && (age ? age <= 25 : /\b(teen|teenager|young|youth|college)\b/.test(d))
  const who = old ? (female ? 'an elderly woman' : 'an elderly man') : child ? (female ? 'a young girl' : 'a young boy') : young ? (female ? 'a young woman' : 'a young man') : female ? 'a woman' : 'a man'
  return `${who}'s ${v.toLowerCase().replace(/^(female|male|ungendered), /, '')} voice`
}

/** The characters JARVIS has made in his Flow project. */
export function flowCharacterList() {
  return Object.values(readFlow().characters ?? {})
}

/**
 * Remember a character that is described in words rather than uploaded
 * (children: Flow won't animate them from a picture). Their description is
 * written into every scene they're in.
 */
export function flowRememberTextCharacter({ name, description, image, voice }) {
  const state = readFlow()
  state.characters = { ...(state.characters ?? {}), [keyOf(name)]: { name, description, image, voice, textOnly: true } }
  saveFlow(state)
}

/** The voices already given to characters (so no two share one). */
export const takenVoices = () => flowCharacterList().map((c) => c.voice).filter(Boolean)

/** Give a Flow character its voice ("Select a voice" → the voice → Add to character). */
async function setCharacterVoice(page, voice) {
  await page.getByRole('button', { name: /Select a voice|voice_selection/ }).first().click({ timeout: 10_000 })
  await page.waitForTimeout(1500)
  // The option's text runs together: "voice_selectionAlgenibMale, gravelly, …".
  const opt = () => page.locator('.cdk-overlay-container [role="option"]').filter({ hasText: new RegExp(`${voice}\\s*(Male|Female|Ungendered)`) })
  // The list is long: scroll until the voice is there.
  for (let i = 0; i < 12 && !(await opt().count()); i++) {
    await page.locator('.cdk-overlay-container [role="option"]').last().scrollIntoViewIfNeeded().catch(() => {})
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(500)
  }
  if (!(await opt().count())) throw new Error(`Flow has no voice called ${voice}.`)
  await opt().first().click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Add to character' }).click({ timeout: 8000 })
  await page.waitForTimeout(1500)
}

/** Give an existing Flow character a voice (and remember it). */
export function flowSetVoice(name, voice) {
  const run = busy.then(async () => {
    const state = readFlow()
    const c = state.characters?.[keyOf(name)]
    if (!c) throw new Error(`No character called ${name}.`)
    if (!c.textOnly) {
      await ensureChrome()
      const b = await connect()
      let page
      try {
        page = await b.contexts()[0].newPage()
        await page.goto(`${state.project}/character/${c.id}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.waitForTimeout(4000)
        await setCharacterVoice(page, voice)
        await page.getByRole('button', { name: 'Done', exact: true }).first().click({ timeout: 8000 }).catch(() => {})
        await page.waitForTimeout(1500)
      } finally {
        await page?.close().catch(() => {})
        await b.close().catch(() => {})
      }
    }
    c.voice = voice
    saveFlow(state)
    return c
  })
  busy = run.catch(() => {})
  return run
}

/** Split a scene's characters: attached in Flow, or written into the prompt. */
function castFor(names) {
  const known = readFlow().characters ?? {}
  const attach = []
  const written = []
  for (const n of names) {
    const c = known[keyOf(n)]
    if (c?.textOnly) written.push(c)
    else attach.push(n)
  }
  return { attach, written }
}

/** Upload a picture as a new Flow character, named and described. */
export function flowAddCharacter({ name, description = '', image, voice }) {
  const run = busy.then(() => addCharacter(name, description, image, voice))
  busy = run.catch(() => {})
  return run
}

async function addCharacter(name, description, image, voice) {
  if (!existsSync(image)) throw new Error(`No picture at ${image}`)
  await ensureChrome()
  const b = await connect()
  let page
  try {
    const ctx = b.contexts()[0]
    const p = await openFlowProject(ctx)
    page = p.page
    await page.goto(`${p.state.project}/character`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(3000)
    await dismissFlowNotices(page)
    const chooser = page.waitForEvent('filechooser', { timeout: 15_000 })
    await page.getByRole('button', { name: /Upload/ }).first().click({ timeout: 15_000 })
    await (await chooser).setFiles(image)
    // "Rights to use this image": the user's own story characters.
    const agree = page.getByRole('button', { name: 'I agree' })
    await agree.first().waitFor({ timeout: 8000 }).then(() => agree.first().click(), () => {})
    await page.waitForURL(/\/character\/[0-9a-f-]+/, { timeout: 60_000 })
    const id = page.url().split('/character/')[1].split(/[?#]/)[0]
    const nameBox = page.getByLabel('Character name')
    await nameBox.fill(name)
    await nameBox.press('Enter').catch(() => {})
    if (description) await page.getByLabel('Character personality').fill(description.slice(0, 1500)).catch(() => {})
    // Wait until the picture has really landed on the character. Flow refuses
    // some pictures (realistic photos of children, for one) with "Failed to
    // upload image to character" and the counter stalls at 99%.
    let landed = false
    let refused = false
    for (let i = 0; i < 120 && !landed && !refused; i++) {
      await page.waitForTimeout(1000)
      const st = await page.evaluate(() => ({
        refused: /Failed to upload image to character/i.test(document.body.innerText),
        pct: /\b\d{1,3}%/.test(document.body.innerText),
        picture: [...document.querySelectorAll('img')].some((im) => im.naturalWidth > 200),
      }))
      refused = st.refused
      landed = !st.pct && st.picture
    }
    if (!landed) {
      // Don't leave a character without a picture behind.
      await page.getByRole('button', { name: 'Move to trash' }).click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(1500)
      throw new Error(
        refused
          ? `Google Flow refused the picture of ${name} (it doesn't accept realistic photos of children; an animated, Pixar-style look works).`
          : `The picture of ${name} didn't finish uploading to Google Flow.`,
      )
    }
    // Its own voice, so it always sounds the same when it speaks.
    if (voice) await setCharacterVoice(page, voice).catch((err) => console.log(`[jarvis] couldn't set ${name}'s voice: ${err.message}`))
    await page.getByRole('button', { name: 'Done', exact: true }).first().click({ timeout: 10_000 })
    await page.waitForTimeout(2500)
    const state = readFlow()
    state.characters = { ...(state.characters ?? {}), [keyOf(name)]: { name, id, description, voice } }
    saveFlow(state)
    return { name, id }
  } finally {
    await page?.close().catch(() => {})
    await b.close().catch(() => {})
  }
}

/** Attach characters (by name) to the prompt box from the ingredients picker. */
async function attachCharacters(page, names) {
  const attached = []
  // An attached character shows as an "Ingredient" chip in the prompt box
  // (with its picture, or just an icon while the picture loads).
  const chips = () => page.locator('button[aria-label="Ingredient"]').count()
  for (const n of names) {
    await clearFlowOverlays(page)
    const had = await chips()
    await page.getByRole('button', { name: 'Add ingredients to the prompt box' }).last().click({ timeout: 10_000 })
    await page.locator('.cdk-overlay-container [role="tab"]').filter({ hasText: 'Characters' }).first().click({ timeout: 8000 })
    await page.waitForTimeout(1500)
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const opt = page.locator('.cdk-overlay-container [role="option"]').filter({ hasText: new RegExp(`^\\s*${esc}\\s*$`, 'i') })
    const loose = page.locator('.cdk-overlay-container [role="option"]').filter({ hasText: new RegExp(esc, 'i') })
    const pick = (await opt.count()) ? opt : loose
    if (!(await pick.count())) {
      await clearFlowOverlays(page)
      throw new Error(`The character "${n}" isn't in Flow yet.`)
    }
    // One click adds it to the prompt (a chip with its picture appears).
    await pick.first().click()
    for (let i = 0; i < 10 && (await chips()) <= had; i++) await page.waitForTimeout(500)
    if ((await chips()) <= had) {
      const add = page.getByRole('button', { name: 'Add to prompt' })
      if (await add.count()) await add.last().click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(1200)
    }
    if ((await chips()) <= had) throw new Error(`Couldn't add "${n}" to the prompt in Flow.`)
    attached.push(n)
  }
  await clearFlowOverlays(page)
  return attached
}

// ==================================================================== ChatGPT
//
// Character reference pictures, made in the user's own ChatGPT (signed in
// once in this same window): a new chat, the reference prompt, and the
// finished "Generated image" read straight out of the page (it is a blob:
// address, so it can only be fetched from inside the page).

/** ChatGPT's image allowance is used up for now. */
export class ImageLimitError extends Error {}

export function chatgptImage(prompt, out) {
  const run = busy.then(() => makeChatgptImage(prompt, out))
  busy = run.catch(() => {})
  return run
}

async function makeChatgptImage(prompt, out) {
  await ensureChrome()
  const b = await connect()
  let page
  try {
    page = await b.contexts()[0].newPage()
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(5000)
    const loggedOut = await page.evaluate(() => [...document.querySelectorAll('button, a')].some((e) => /^\s*log in\s*$/i.test(e.textContent || '')))
    if (loggedOut) throw new Error('Not signed in to ChatGPT in my window. Say "log in to ChatGPT" and sign in once.')
    const box = page.locator('#prompt-textarea, div[contenteditable="true"]').first()
    await box.click({ timeout: 20_000 })
    await page.keyboard.insertText(prompt)
    await page.keyboard.press('Enter')

    const t0 = Date.now()
    while (Date.now() - t0 < 6 * 60_000) {
      await page.waitForTimeout(4000)
      const st = await page.evaluate(() => {
        const turn = [...document.querySelectorAll('[data-message-author-role="assistant"]')].pop()
        const scope = turn?.closest('article, [data-testid^="conversation-turn"]') || document
        const img = [...scope.querySelectorAll('img[alt^="Generated image"]')].pop()
        return {
          busy: !!document.querySelector('[data-testid="stop-button"]'),
          ready: !!img && img.complete && img.naturalWidth >= 512,
          said: (turn?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
        }
      })
      if (st.ready && !st.busy) {
        const data = await page.evaluate(async () => {
          const img = [...document.querySelectorAll('img[alt^="Generated image"]')].pop()
          const blob = await (await fetch(img.src)).blob()
          const buf = new Uint8Array(await blob.arrayBuffer())
          let s = ''
          for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
          return btoa(s)
        })
        writeFileSync(out, Buffer.from(data, 'base64'))
        return { file: out, seconds: Math.round((Date.now() - t0) / 1000) }
      }
      if (!st.busy && /(limit|too many|try again (later|in)|come back)/i.test(st.said) && !st.ready) {
        throw new ImageLimitError(`ChatGPT says: ${st.said.slice(0, 200)}`)
      }
      if (!st.busy && st.said && Date.now() - t0 > 60_000 && !st.ready && /can't|cannot|unable|not able|policy/i.test(st.said)) {
        throw new Error(`ChatGPT says: ${st.said.slice(0, 200)}`)
      }
    }
    throw new Error('ChatGPT took longer than 6 minutes to make the picture.')
  } finally {
    await page?.close().catch(() => {})
    await b.close().catch(() => {})
  }
}

/** Open ChatGPT in JARVIS's window so the user can sign in (once). */
export async function openChatgptLogin() {
  await ensureChrome({ show: true, url: 'https://chatgpt.com/auth/login' })
  if (await up()) {
    const b = await connect()
    try {
      const p = await b.contexts()[0].newPage()
      await p.goto('https://chatgpt.com/auth/login').catch(() => {})
      await p.bringToFront().catch(() => {})
    } finally {
      await b.close().catch(() => {})
    }
  }
}
