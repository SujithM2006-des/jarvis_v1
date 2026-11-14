import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The conversation journal: every exchange, kept across restarts.
 *
 *   ~/.jarvis/history.jsonl   one line per exchange: { at, user, reply, tools }
 *
 * memory.md holds the facts worth knowing forever; this holds what was said
 * and done. A new session starts with the most recent exchanges in its system
 * prompt, so after a shutdown he carries on where he left off ("did you save
 * that file?"), and `search_history` reaches anything older.
 *
 * It never leaves the machine except as part of the prompt to the model, the
 * same way the conversation itself does.
 */

const DIR = join(homedir(), '.jarvis')
export const HISTORY = join(DIR, 'history.jsonl')
mkdirSync(DIR, { recursive: true })

/** Kept on disk; older lines are dropped once the file passes this. */
const MAX_ENTRIES = 5000
/** Carried into each new session. */
// Kept modest: this rides along on every turn of every session, so it is paid
// for again and again. Anything older is one search_history call away.
// Kept short: this rides along with every request (tokens on each turn).
// Older history is still searchable with search_history.
const RECENT_ENTRIES = 12
const RECENT_CHARS = 3_000

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

const pretty = (iso) =>
  new Date(iso).toLocaleString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  })

export function readHistory() {
  try {
    return readFileSync(HISTORY, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter((e) => e && e.at && (e.user || e.reply))
  } catch {
    return []
  }
}

function rewrite(entries) {
  const tmp = HISTORY + '.tmp'
  writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
  renameSync(tmp, HISTORY)
}

let writes = 0

/** Save one finished exchange. */
export function record({ user, reply, tools }) {
  const u = clip(user, 2000)
  const r = clip(reply, 4000)
  if (!u && !r) return
  const entry = { at: new Date().toISOString(), user: u, reply: r }
  const t = [...new Set((tools ?? []).filter(Boolean))]
  if (t.length) entry.tools = t
  try {
    appendFileSync(HISTORY, JSON.stringify(entry) + '\n')
    // Trim now and then rather than on every write.
    if (++writes % 50 === 0) {
      const all = readHistory()
      if (all.length > MAX_ENTRIES) rewrite(all.slice(-MAX_ENTRIES))
    }
  } catch (err) {
    console.warn(`[jarvis] could not write history: ${err.message}`)
  }
}

const line = (e) =>
  `[${pretty(e.at)}] User: ${clip(e.user, 400)}\n  You: ${clip(e.reply, 600)}` +
  (e.tools?.length ? `\n  (did: ${e.tools.join(', ')})` : '')

/** The recent conversation, as a system prompt section. */
export function journalPrompt() {
  const all = readHistory()
  if (!all.length) return ''
  const picked = []
  let size = 0
  for (let i = all.length - 1; i >= 0 && picked.length < RECENT_ENTRIES; i--) {
    const l = line(all[i])
    if (size + l.length > RECENT_CHARS) break
    picked.unshift(l)
    size += l.length
  }
  return (
    '\n\nYOUR RECENT CONVERSATIONS WITH THE USER — from this and earlier sessions, oldest ' +
    'first, kept across restarts. This is your own memory of what was said and done: use it ' +
    'naturally ("the PDF I saved this morning"), never recite it, and never say you are ' +
    'reading a log. For anything older or not here, call `search_history`.\n' +
    picked.join('\n') +
    '\n'
  )
}

/** Keyword search over the whole journal, best matches first. */
export function searchHistory(query, { days, limit = 12 } = {}) {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9\u0080-￿]+/)
    .filter((w) => w.length > 2)
  const since = days ? Date.now() - days * 86_400_000 : 0
  const all = readHistory().filter((e) => new Date(e.at).getTime() >= since)
  if (!words.length) return all.slice(-limit).map(line)
  return all
    .map((e, i) => {
      const hay = `${e.user} ${e.reply} ${(e.tools ?? []).join(' ')}`.toLowerCase()
      let score = 0
      for (const w of words) if (hay.includes(w)) score++
      return { e, i, score }
    })
    .filter((x) => x.score > 0)
    // Most words matched, then most recent.
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, limit)
    .sort((a, b) => a.i - b.i)
    .map((x) => line(x.e))
}

/** Remove exchanges mentioning these words ("forget what I said about …"). */
export function forgetHistory(matching) {
  const m = String(matching ?? '').toLowerCase().trim()
  if (!m || !existsSync(HISTORY)) return 0
  const all = readHistory()
  const kept = all.filter((e) => !`${e.user} ${e.reply}`.toLowerCase().includes(m))
  if (kept.length !== all.length) rewrite(kept)
  return all.length - kept.length
}
