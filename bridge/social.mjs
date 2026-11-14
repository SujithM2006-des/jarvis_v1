/**
 * Social media links: paste one, and JARVIS reviews what is in it.
 *
 *   review_link    any post or video link — YouTube, Instagram, TikTok, X,
 *                  Facebook, Reddit, LinkedIn, Threads, Vimeo, Pinterest, and
 *                  the 1,000+ other sites yt-dlp knows. Returns the details
 *                  (title, caption, creator, views, likes, comments, length,
 *                  date), what is said (captions, or the audio transcribed
 *                  offline), and frames from across the video as pictures to
 *                  look at. Photo and text posts: read from the page, with a
 *                  screenshot.
 *   social_login   log in once, in JARVIS's own browser window, to a site that
 *                  hides posts from visitors (Instagram, Facebook, X …). The
 *                  password goes only to that site; JARVIS keeps the login
 *                  (cookies, on this PC) and uses it for links.
 *
 * yt-dlp (in the wake listener's Python) does the reading; ffmpeg the frames
 * and audio; Vosk the offline transcription; Chrome, through playwright-core
 * in a profile of its own (~/.jarvis/social-profile), the logins and pages.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findTool } from './creator.mjs'

const HOME = homedir()
const VENV = join(HOME, '.jarvis', 'wake-venv', 'Scripts')
const YTDLP = join(VENV, 'yt-dlp.exe')
const PY = join(VENV, 'python.exe')
const SCRIPTS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'scripts')
const PROFILE = join(HOME, '.jarvis', 'social-profile')
const COOKIES = join(HOME, '.jarvis', 'social-cookies.txt')

const textPart = (t) => ({ type: 'text', text: t })
const failText = (t) => ({ isError: true, content: [textPart(t)] })
const stamp = () => new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 16)
const cookieArgs = () => (existsSync(COOKIES) ? ['--cookies', COOKIES] : [])

function run(file, args, timeoutMs = 90_000) {
  return new Promise((res, rej) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const lines = String(stderr || err.message).split('\n').map((l) => l.trim()).filter(Boolean)
        const why = err.killed ? `took longer than ${timeoutMs / 1000} s` : (lines.slice().reverse().find((l) => /^ERROR/.test(l)) ?? lines[0] ?? 'failed')
        return rej(new Error(why.replace(/^ERROR:\s*/, '')))
      }
      res(String(stdout))
    })
  })
}

// ---------------------------------------------------------------- sites

const SITES = [
  { id: 'instagram', re: /instagram\.com/, login: 'https://www.instagram.com/accounts/login/', cookie: 'sessionid' },
  { id: 'threads', re: /threads\.(net|com)/, login: 'https://www.threads.net/login', cookie: 'sessionid' },
  { id: 'facebook', re: /facebook\.com|fb\.watch/, login: 'https://www.facebook.com/login', cookie: 'c_user' },
  { id: 'x', re: /(^|[/.])x\.com|twitter\.com/, login: 'https://x.com/i/flow/login', cookie: 'auth_token' },
  { id: 'tiktok', re: /tiktok\.com/, login: 'https://www.tiktok.com/login', cookie: 'sessionid' },
  { id: 'linkedin', re: /linkedin\.com/, login: 'https://www.linkedin.com/login', cookie: 'li_at' },
  { id: 'reddit', re: /reddit\.com|redd\.it/, login: 'https://www.reddit.com/login', cookie: 'reddit_session' },
  { id: 'youtube', re: /youtube\.com|youtu\.be/, login: 'https://accounts.google.com/ServiceLogin?service=youtube', cookie: 'SID' },
  { id: 'pinterest', re: /pinterest\./, login: 'https://www.pinterest.com/login/', cookie: '_pinterest_sess' },
]
const siteOf = (url) => SITES.find((s) => s.re.test(url)) ?? null

// ---------------------------------------------------------------- browser

let browser = null // one persistent context at a time (the profile is locked while open)

async function openProfile(headless) {
  if (browser) {
    await browser.close().catch(() => {})
    browser = null
  }
  const { chromium } = await import('playwright-core')
  mkdirSync(PROFILE, { recursive: true })
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless,
    viewport: headless ? { width: 1280, height: 900 } : null,
    args: headless ? [] : ['--start-maximized'],
  })
  ctx.on('close', () => {
    if (browser === ctx) browser = null
  })
  browser = ctx
  return ctx
}

/** The profile's cookies as a Netscape cookies.txt, for yt-dlp. */
async function saveCookies(ctx) {
  const all = await ctx.cookies()
  const lines = ['# Netscape HTTP Cookie File', '# Made by JARVIS from his social browser. Keep private.']
  for (const c of all) {
    const sub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE'
    lines.push([c.domain, sub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', Math.max(0, Math.round(c.expires || 0)), c.name, c.value].join('\t'))
  }
  writeFileSync(COOKIES, lines.join('\n') + '\n')
  return all
}

/** Logged in to a site already? (its session cookie is in the saved cookies) */
function loggedIn(site) {
  try {
    return readFileSync(COOKIES, 'utf8')
      .split('\n')
      .some((l) => {
        const f = l.split('\t')
        return f.length >= 7 && site.re.test(`https://${f[0].replace(/^\./, '')}/`) && f[5] === site.cookie
      })
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- reading a link

const fmtNum = (n) => (n == null ? null : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n))
const fmtDur = (s) => (s == null ? null : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`)
const fmtDate = (d) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : null)

/** Caption text from a VTT/SRT/json3 file's contents: words only, repeats dropped. */
function captionText(raw) {
  if (raw.trim().startsWith('{')) {
    try {
      const j = JSON.parse(raw)
      return (j.events ?? []).flatMap((e) => (e.segs ?? []).map((s) => s.utf8)).join('').replace(/\s+/g, ' ').trim()
    } catch {
      /* not json3 */
    }
  }
  const out = []
  for (let line of raw.split(/\r?\n/)) {
    line = line.replace(/<[^>]+>/g, '').trim()
    if (!line || /^(WEBVTT|Kind:|Language:|NOTE)|-->|^\d+$/.test(line)) continue
    if (out[out.length - 1] !== line) out.push(line)
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

async function fetchCaptions(info) {
  const pick = (tracks) => {
    if (!tracks) return null
    const langs = Object.keys(tracks)
    const lang = ['en', 'en-IN', 'en-US', 'en-GB', 'en-orig'].find((l) => langs.includes(l)) ?? langs.find((l) => l.startsWith('en')) ?? langs.find((l) => /-orig$/.test(l)) ?? null
    if (!lang) return null
    const fmts = tracks[lang]
    return fmts.find((f) => f.ext === 'json3') ?? fmts.find((f) => f.ext === 'vtt') ?? fmts[0]
  }
  const track = pick(info.subtitles) ?? pick(info.automatic_captions)
  if (!track?.url) return null
  try {
    const r = await fetch(track.url, { signal: AbortSignal.timeout(20000) })
    if (!r.ok) return null
    return captionText(await r.text()) || null
  } catch {
    return null
  }
}

/** The video (480p or less, with sound) into the work folder; its path, or null. */
async function downloadSmall(url, work) {
  const ff = findTool('ffmpeg')
  await run(
    YTDLP,
    [
      '-f', 'b[height<=480]/bv*[height<=480]+ba/w',
      '-o', join(work, 'media.%(ext)s'),
      '--no-playlist', '--no-warnings', '--max-filesize', '400M',
      ...(ff ? ['--ffmpeg-location', dirname(ff)] : []),
      ...cookieArgs(),
      url,
    ],
    6 * 60_000,
  )
  const f = readdirSync(work).find((n) => n.startsWith('media.') && !n.endsWith('.part'))
  return f ? join(work, f) : null
}

/** Evenly spaced frames as small JPEGs (base64), for JARVIS to look at. */
async function frames(media, duration, n, work) {
  const ff = findTool('ffmpeg')
  if (!ff) return []
  const out = []
  const d = Math.max(1, duration || 10)
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) * d) / n
    const f = join(work, `frame${i}.jpg`)
    try {
      await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', t.toFixed(2), '-i', media, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '5', f], 60_000)
      if (existsSync(f)) out.push({ t, data: readFileSync(f).toString('base64') })
    } catch {
      /* skip that moment */
    }
  }
  return out
}

/** What is said, transcribed offline (Vosk) from the media's audio. */
async function transcribe(media, work) {
  const ff = findTool('ffmpeg')
  if (!ff || !existsSync(PY)) return null
  const wav = join(work, 'audio.wav')
  await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', media, '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', wav], 120_000)
  const t = (await run(PY, ['-I', join(SCRIPTS, 'transcribe.py'), wav], 10 * 60_000)).trim()
  return t || null
}

/** A page in JARVIS's social browser: its text, meta details and a screenshot. */
async function readPage(url) {
  const ctx = await openProfile(true)
  try {
    const page = await ctx.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(3500)
    const meta = await page.evaluate(() => {
      const m = (p) => document.querySelector(`meta[property="${p}"],meta[name="${p}"]`)?.getAttribute('content') ?? ''
      return {
        title: m('og:title') || document.title,
        description: m('og:description') || m('description'),
        site: m('og:site_name'),
        text: (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, 5000),
        url: location.href,
      }
    })
    const shot = (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64')
    await saveCookies(ctx).catch(() => {})
    return { ...meta, shot }
  } finally {
    await ctx.close().catch(() => {})
  }
}

// ---------------------------------------------------------------- the tools

async function reviewLink({ url, frames: nFrames = 4, transcript = true }) {
  if (!existsSync(YTDLP)) return failText("yt-dlp is not installed (pip install yt-dlp in the wake listener's Python).")
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  const site = siteOf(url)
  const work = join(tmpdir(), `jarvis-link-${stamp()}`)
  mkdirSync(work, { recursive: true })
  const parts = []
  try {
    let info = null
    let why = ''
    try {
      info = JSON.parse(await run(YTDLP, ['-J', '--skip-download', '--no-warnings', '--no-playlist', ...cookieArgs(), url], 90_000))
    } catch (err) {
      why = err.message
    }

    if (site?.id === 'tiktok' && /timed out|getaddrinfo|ENOTFOUND|Unable to connect|connection/i.test(why)) {
      return failText('TikTok could not be reached — it is blocked in India, so it only works through a VPN.')
    }

    if (info) {
      const stats = [
        info.view_count != null && `${fmtNum(info.view_count)} views`,
        info.like_count != null && `${fmtNum(info.like_count)} likes`,
        info.comment_count != null && `${fmtNum(info.comment_count)} comments`,
        info.repost_count != null && `${fmtNum(info.repost_count)} shares`,
      ].filter(Boolean)
      const by = info.uploader || info.channel || info.creator
      parts.push(
        textPart(
          [
            `Platform: ${info.extractor_key ?? site?.id ?? 'web'}`,
            info.title && `Title: ${info.title}`,
            by && `By: ${by}${info.channel_follower_count ? ` (${fmtNum(info.channel_follower_count)} followers)` : ''}`,
            fmtDate(info.upload_date) && `Posted: ${fmtDate(info.upload_date)}`,
            info.duration != null && `Length: ${fmtDur(info.duration)}`,
            stats.length && stats.join(' · '),
            info.tags?.length && `Tags: ${info.tags.slice(0, 15).join(', ')}`,
            info.description && `Caption / description:\n${String(info.description).slice(0, 3000)}`,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      )

      let said = transcript ? await fetchCaptions(info) : null
      const fromCaptions = Boolean(said)
      const isVideo = info.duration != null || (info.vcodec && info.vcodec !== 'none')
      const short = (info.duration ?? 0) <= 20 * 60
      let media = null
      if (isVideo && short && (nFrames > 0 || (transcript && !said))) {
        media = await downloadSmall(url, work).catch((err) => {
          parts.push(textPart(`(Could not download the video to look at it: ${err.message.slice(0, 160)})`))
          return null
        })
      }
      if (transcript && !said && media) said = await transcribe(media, work).catch(() => null)
      if (said) parts.push(textPart(`What is said${fromCaptions ? '' : ' (transcribed offline — may have errors)'}:\n${said.slice(0, 15000)}`))
      else if (transcript && isVideo) parts.push(textPart(short ? '(No speech or captions found.)' : '(Long video without captions: only the details above.)'))

      const shots = media && nFrames > 0 ? await frames(media, info.duration, Math.min(8, nFrames), work) : []
      if (shots.length) {
        parts.push(textPart(`Frames from the video, at ${shots.map((s) => fmtDur(s.t)).join(', ')}:`))
        for (const s of shots) parts.push({ type: 'image', data: s.data, mimeType: 'image/jpeg' })
      } else if (info.thumbnail) {
        try {
          const r = await fetch(info.thumbnail, { signal: AbortSignal.timeout(15000) })
          const type = r.headers.get('content-type') || ''
          if (r.ok && /^image\/(jpeg|png|webp|gif)/.test(type)) {
            parts.push(textPart('Thumbnail / picture:'), { type: 'image', data: Buffer.from(await r.arrayBuffer()).toString('base64'), mimeType: type.split(';')[0] })
          }
        } catch {
          /* no picture */
        }
      }
      return { content: parts }
    }

    // Not something yt-dlp can read (a photo or text post, or a login wall):
    // the page itself, in JARVIS's own browser (with his logins).
    let p
    try {
      p = await readPage(url)
    } catch (err) {
      return failText(`Could not read the link: ${why || err.message}`)
    }
    const wall = /log ?in|sign ?up|sign ?in/i.test(p.title) || /accounts\/login|\/login|i\/flow\/login/.test(p.url)
    if (wall && site && !loggedIn(site)) {
      return failText(
        `${site.id[0].toUpperCase() + site.id.slice(1)} only shows this to logged-in users. Offer social_login ` +
          `("log in to ${site.id}"): they log in once in my own browser window — the password goes only to ${site.id}.`,
      )
    }
    parts.push(textPart([`Page: ${p.title}`, p.site && `Site: ${p.site}`, p.description && `Caption / description: ${p.description}`, `Visible text:\n${p.text}`].filter(Boolean).join('\n')))
    parts.push(textPart('Screenshot of the post:'), { type: 'image', data: p.shot, mimeType: 'image/jpeg' })
    if (site && site.id !== 'youtube' && !loggedIn(site)) {
      parts.push(textPart(`(Not logged in to ${site.id}: if the post looks hidden or unavailable, offer social_login — ${site.id} shows most posts only to logged-in users.)`))
    }
    return { content: parts }
  } catch (err) {
    return failText(`Could not read the link: ${err.message}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function socialLogin({ site: id }) {
  const site = SITES.find((s) => s.id === id)
  let ctx
  try {
    ctx = await openProfile(false)
  } catch (err) {
    return failText(`Could not open the login window: ${err.message}`)
  }
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(site.login, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    await page.bringToFront().catch(() => {})
    const until = Date.now() + 5 * 60_000
    while (Date.now() < until && browser === ctx) {
      const cookies = await ctx.cookies().catch(() => [])
      if (cookies.some((c) => c.name === site.cookie && c.value && site.re.test(`https://${c.domain.replace(/^\./, '')}/`))) {
        await new Promise((r) => setTimeout(r, 2000))
        await saveCookies(ctx)
        return { content: [textPart(`Logged in to ${id}. Links from it will work now.`)] }
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
    if (browser === ctx) await saveCookies(ctx).catch(() => {})
    return failText(`No ${id} login seen within 5 minutes (or the window was closed). Try again when ready.`)
  } finally {
    await ctx.close().catch(() => {})
  }
}

export function socialServer() {
  return createSdkMcpServer({
    name: 'jarvis_social',
    version: '1.0.0',
    tools: [
      tool(
        'review_link',
        'Read a social media or video link so you can review, summarise or answer about it: YouTube, ' +
          'Instagram, TikTok, X/Twitter, Facebook, Reddit, LinkedIn, Threads, Vimeo, Pinterest and ' +
          'more. Returns the details (caption, creator, views, likes, comments, length, date), what ' +
          'is said (captions, or the audio transcribed), and frames from across the video to look ' +
          'at. Takes 10-60 s for a video. If it says a login is needed, offer social_login.',
        {
          url: z.string(),
          frames: z.number().int().min(0).max(8).optional().describe('Pictures from the video, default 4 (0 for none)'),
          transcript: z.boolean().optional().describe('What is said (default true)'),
        },
        reviewLink,
      ),
      tool(
        'social_login',
        'Log in once to a site that hides posts from visitors (instagram, facebook, x, threads, tiktok, ' +
          "linkedin, reddit, youtube, pinterest) in JARVIS's own browser window. The user types the " +
          'password there themselves (it goes only to that site). Waits up to 5 minutes for the login, ' +
          'then keeps it on this PC for review_link.',
        { site: z.enum(['instagram', 'facebook', 'x', 'threads', 'tiktok', 'linkedin', 'reddit', 'youtube', 'pinterest']) },
        socialLogin,
      ),
    ],
  })
}

export const PROMPT_SOCIAL = `Links to posts and videos (YouTube, Instagram, TikTok, X, Facebook, Reddit …):
- A pasted link to review, summarise or ask about: review_link. It returns the
  details, what is said and frames to look at. Then answer like a reviewer:
  what it is about, the hook, what works, what could be better, as asked.
- If it says a login is needed: offer social_login for that site (they log in
  themselves in your browser window; you never see the password).
- TikTok is blocked in India; it works only through a VPN.

`
