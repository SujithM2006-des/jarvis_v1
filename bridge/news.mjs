/**
 * News: today's headlines in every sector, kept fresh while online.
 *
 * Every 2 hours (when the internet is up) the latest headlines are fetched
 * from Google News' RSS feeds — top stories, world, India, business,
 * technology, science, health, sports, entertainment — and stored on this PC
 * (~/.jarvis/news/<date>.json, kept 30 days). So JARVIS knows what is going
 * on with any brain — Claude, Gemini, Groq, OpenRouter or the local model —
 * and even offline, as of the last update.
 *
 * Today's top headlines also ride along in the system prompt (a few per
 * sector), so "what's happening today?" needs no tool at all. The tools here
 * list and search everything stored. (On Claude, WebSearch/WebFetch still
 * read the full articles and anything else live.)
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(homedir(), '.jarvis', 'news')
const KEEP_DAYS = 30
const EVERY_MS = 2 * 60 * 60 * 1000

const BASE = 'https://news.google.com/rss'
const ED = 'hl=en-IN&gl=IN&ceid=IN:en'
export const SECTORS = {
  top: { label: 'Top stories', url: `${BASE}?${ED}` },
  world: { label: 'World', url: `${BASE}/headlines/section/topic/WORLD?${ED}` },
  india: { label: 'India', url: `${BASE}/headlines/section/topic/NATION?${ED}` },
  business: { label: 'Business', url: `${BASE}/headlines/section/topic/BUSINESS?${ED}` },
  technology: { label: 'Technology', url: `${BASE}/headlines/section/topic/TECHNOLOGY?${ED}` },
  science: { label: 'Science', url: `${BASE}/headlines/section/topic/SCIENCE?${ED}` },
  health: { label: 'Health', url: `${BASE}/headlines/section/topic/HEALTH?${ED}` },
  sports: { label: 'Sports', url: `${BASE}/headlines/section/topic/SPORTS?${ED}` },
  entertainment: { label: 'Entertainment', url: `${BASE}/headlines/section/topic/ENTERTAINMENT?${ED}` },
}

const day = (d = new Date()) => d.toISOString().slice(0, 10)
const file = (d) => join(DIR, `${d}.json`)

const decode = (s) =>
  String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** RSS items: title (without the trailing " - Source"), source, link, time. */
function parse(xml, sector) {
  const out = []
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const pick = (tag) => decode((m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) ?? [])[1] ?? '')
    let title = pick('title')
    const source = pick('source')
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3))
    if (!title) continue
    const at = Date.parse(pick('pubDate')) || Date.now()
    out.push({ sector, title, source, link: pick('link'), at })
  }
  return out
}

function readDay(d) {
  try {
    return JSON.parse(readFileSync(file(d), 'utf8'))
  } catch {
    return []
  }
}

/** Everything stored from the last `days` days, newest first. */
export function storedNews(days = 2) {
  const all = []
  for (let i = 0; i < days; i++) all.push(...readDay(day(new Date(Date.now() - i * 86400000))))
  return all.sort((a, b) => b.at - a.at)
}

let lastFetch = 0
let fetching = false

/** Fetch every sector now and merge into today's file. Returns how many are new. */
export async function refreshNews() {
  if (fetching) return 0
  fetching = true
  try {
    const fresh = []
    await Promise.all(
      Object.entries(SECTORS).map(async ([id, s]) => {
        try {
          const r = await fetch(s.url, {
            headers: { 'user-agent': 'Mozilla/5.0 (JARVIS news reader)' },
            signal: AbortSignal.timeout(15000),
          })
          if (r.ok) fresh.push(...parse(await r.text(), id).slice(0, 25))
        } catch {
          /* that sector waits for the next round */
        }
      }),
    )
    if (!fresh.length) return 0
    mkdirSync(DIR, { recursive: true })
    const today = readDay(day())
    const seen = new Set(today.map((n) => n.title.toLowerCase()))
    const added = fresh.filter((n) => !seen.has(n.title.toLowerCase()) && seen.add(n.title.toLowerCase()))
    writeFileSync(file(day()), JSON.stringify([...today, ...added]))
    lastFetch = Date.now()
    // Older than the keep window: gone.
    const cutoff = day(new Date(Date.now() - KEEP_DAYS * 86400000))
    for (const f of readdirSync(DIR)) if (f.endsWith('.json') && f.slice(0, 10) < cutoff) rmSync(join(DIR, f), { force: true })
    console.log(`[jarvis] news updated: ${added.length} new headlines (${fresh.length} fetched)`)
    return added.length
  } finally {
    fetching = false
  }
}

/**
 * Keep it fresh: now, then every 2 hours, but only while `online()` says the
 * internet is up (checked again each round).
 */
export function startNews(online) {
  const tick = () => {
    if (online() && Date.now() - lastFetch > EVERY_MS - 60_000) void refreshNews()
  }
  setTimeout(tick, 20_000)
  setInterval(tick, 10 * 60_000).unref()
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000)
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

/** A short block for the system prompt: the newest few per sector. */
export function newsPrompt(perSector = 2) {
  const items = storedNews(2)
  if (!items.length) return ''
  const lines = []
  for (const [id, s] of Object.entries(SECTORS)) {
    const top = items.filter((n) => n.sector === id).slice(0, perSector)
    if (top.length) lines.push(`${s.label}: ${top.map((n) => n.title).join(' | ')}`)
  }
  const newest = Math.max(...items.map((n) => n.at))
  return (
    `\nToday's news (headlines, updated ${ago(newest)}; use news_headlines / news_search for more, ` +
    `and on Claude WebSearch for full stories — never invent details beyond a headline):\n` +
    lines.join('\n') +
    '\n'
  )
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })

export function newsServer() {
  return createSdkMcpServer({
    name: 'jarvis_news',
    version: '1.0.0',
    instructions: 'Latest news headlines in every sector, stored on this PC and refreshed every 2 hours online.',
    alwaysLoad: true,
    tools: [
      tool(
        'news_headlines',
        'The latest news headlines, newest first, for one sector or all: top, world, india, business, ' +
          'technology, science, health, sports, entertainment. Works offline too (as of the last update). ' +
          'Read out the few that matter; never invent details a headline does not give.',
        {
          sector: z.enum(['all', ...Object.keys(SECTORS)]).optional().describe('Default: all'),
          limit: z.number().optional().describe('How many, default 8'),
        },
        async ({ sector = 'all', limit = 8 }) => {
          const items = storedNews(2).filter((n) => sector === 'all' || n.sector === sector)
          if (!items.length) return text('No headlines stored yet — they arrive within a few minutes of being online.')
          return text(
            items
              .slice(0, Math.min(30, Math.max(1, limit)))
              .map((n) => `• ${n.title} — ${n.source || 'news'}, ${ago(n.at)} [${SECTORS[n.sector]?.label ?? n.sector}]`)
              .join('\n'),
          )
        },
      ),
      tool(
        'news_search',
        'Search the stored headlines of the last 30 days for words (a person, company, place, topic). ' +
          'Returns matching headlines with source and time, newest first.',
        { query: z.string(), days: z.number().optional().describe('How far back, default 7, at most 30') },
        async ({ query, days = 7 }) => {
          const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
          const hits = storedNews(Math.min(30, Math.max(1, days))).filter((n) =>
            words.every((w) => `${n.title} ${n.source}`.toLowerCase().includes(w)),
          )
          if (!hits.length) return text(`No stored headline mentions "${query}" in the last ${days} days.`)
          return text(hits.slice(0, 15).map((n) => `• ${n.title} — ${n.source || 'news'}, ${ago(n.at)}`).join('\n'))
        },
      ),
      tool(
        'news_refresh',
        'Fetch the latest headlines right now (needs the internet), instead of waiting for the 2-hourly update.',
        {},
        async () => {
          const n = await refreshNews()
          return text(n ? `Updated: ${n} new headlines.` : 'No new headlines (or no internet).')
        },
      ),
    ],
  })
}
