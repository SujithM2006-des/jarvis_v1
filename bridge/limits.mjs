/**
 * How much of each AI's limit is used, for the Model Usage box — like the
 * Claude app's "Session (5hr) 54%, Weekly 68%".
 *
 *   Claude      the plan's own windows (5-hour, weekly, per-model weekly),
 *               from Anthropic: the rate_limit_event that arrives with
 *               answers, and the agent's usage query when a session is open.
 *   OpenRouter  free-model requests today out of the daily allowance, and
 *               credit used, from its key endpoint.
 *   Groq        requests left today and tokens left this minute, from the
 *               limit headers on one 1-token request (at most every 10 min).
 *   Gemini      Google publishes no usage for free keys: only whether it has
 *               hit its limit (resting) — said so plainly.
 *   Local       runs on this PC: no limit.
 */

import { readKeys } from './brain.mjs'
import { resolvedModel } from './litellm.mjs'

const LABELS = {
  five_hour: 'Session (5hr)',
  seven_day: 'Weekly (7 day)',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  seven_day_oauth_apps: 'Weekly (apps)',
  seven_day_overage_included: 'Weekly (with extra usage)',
  overage: 'Extra usage',
}
const labelOf = (k) =>
  LABELS[k] ?? k.replace(/^seven_day_/, 'Weekly ').replace(/^five_hour_/, 'Session ').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/** A percentage, 0–100, to one decimal below 10 (so 0.1% is not shown as 0). */
const pct = (v) => {
  if (v == null || !Number.isFinite(Number(v))) return null
  const n = Math.max(0, Math.min(100, Number(v)))
  return n < 10 ? Math.round(n * 10) / 10 : Math.round(n)
}
/** Claude's rate_limit_event may give a fraction (0.54) rather than a percentage. */
const fromUtil = (v) => (v == null || !Number.isFinite(Number(v)) ? null : pct(Number(v) <= 1 ? Number(v) * 100 : Number(v)))
const iso = (t) => (t == null ? null : typeof t === 'number' ? new Date(t < 1e12 ? t * 1000 : t).toISOString() : String(t))

// ---------------------------------------------------------------- Claude

/** Latest known windows, by type: { pct, resetsAt, status }. */
const claude = { plan: null, windows: {}, at: 0 }

/** From a `rate_limit_event` in any session's stream. */
export function noteClaudeLimit(info) {
  if (!info?.rateLimitType) return
  const p = fromUtil(info.utilization)
  const prev = claude.windows[info.rateLimitType]
  claude.windows[info.rateLimitType] = {
    pct: p ?? prev?.pct ?? (info.status === 'rejected' ? 100 : null),
    resetsAt: iso(info.resetsAt) ?? prev?.resetsAt ?? null,
    status: info.status,
  }
  claude.at = Date.now()
}

let claudeNext = 0
/** Ask an open Claude session for the plan's windows (once a minute; 10 s after a failure). */
async function refreshClaude(liveQuery) {
  if (!liveQuery || Date.now() < claudeNext) return
  claudeNext = Date.now() + 10_000
  const fn = liveQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
  if (typeof fn !== 'function') return
  try {
    const u = await Promise.race([fn.call(liveQuery), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))])
    if (u?.subscription_type) claude.plan = u.subscription_type
    for (const [k, w] of Object.entries(u?.rate_limits ?? {})) {
      if (!w || w.utilization == null) continue
      claude.windows[k] = { pct: pct(w.utilization), resetsAt: w.resets_at ?? null, status: 'allowed' }
    }
    claude.at = Date.now()
    if (u?.rate_limits) claudeNext = Date.now() + 60_000
  } catch (err) {
    console.log(`[jarvis] Claude usage query failed: ${err.message}`)
  }
}

// ---------------------------------------------------------------- OpenRouter, Groq

const cache = {}
async function cached(id, ttlMs, fn) {
  const c = cache[id]
  if (c && Date.now() - c.at < ttlMs) return c.value
  try {
    const value = await fn()
    cache[id] = { at: Date.now(), value }
    return value
  } catch (err) {
    const value = c?.value ?? { note: `Could not read usage (${String(err.message).slice(0, 60)})`, meters: [] }
    // Don't retry a failing provider on every refresh: again in 30 s.
    cache[id] = { at: Date.now() - ttlMs + 30_000, value }
    return value
  }
}

async function openrouter(key) {
  const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const d = (await r.json()).data ?? {}
  const meters = []
  const free = d.free_model_daily_requests
  if (free?.limit) {
    meters.push({ label: 'Free requests today', pct: pct((free.used / free.limit) * 100), detail: `${free.used} of ${free.limit}`, resetsAt: nextUtcMidnight() })
  }
  if (d.limit) meters.push({ label: 'Credit', pct: pct(((d.usage ?? 0) / d.limit) * 100), detail: `$${(d.usage ?? 0).toFixed(2)} of $${d.limit}` })
  return { meters, note: d.is_free_tier ? 'Free tier' : null }
}

async function groq(key) {
  // The model Jarvis uses there (limits are per model); before it is picked,
  // the first chat model Groq lists.
  let model = resolvedModel('groq')
  if (!model) {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
    model = ((await r.json()).data ?? []).map((m) => String(m.id)).find((id) => !/whisper|guard|tts|playai|embed|compound|vision|distil/i.test(id))
    if (!model) throw new Error('no model')
  }
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    signal: AbortSignal.timeout(10000),
  })
  const h = (n) => r.headers.get(n)
  const lim = Number(h('x-ratelimit-limit-requests'))
  const left = Number(h('x-ratelimit-remaining-requests'))
  const tlim = Number(h('x-ratelimit-limit-tokens'))
  const tleft = Number(h('x-ratelimit-remaining-tokens'))
  const meters = []
  if (lim) meters.push({ label: 'Requests today', pct: pct(((lim - left) / lim) * 100), detail: `${lim - left} of ${lim}`, resetsAt: resetFrom(h('x-ratelimit-reset-requests')) })
  if (tlim) meters.push({ label: 'Tokens this minute', pct: pct(((tlim - tleft) / tlim) * 100), detail: `${tlim - tleft} of ${tlim}` })
  if (!meters.length) throw new Error(r.ok ? 'no limit headers' : `HTTP ${r.status}`)
  return { meters, note: model }
}

/** Groq's reset is a duration ("2m59.56s", "7.66s"). */
function resetFrom(s) {
  if (!s) return null
  let ms = 0
  for (const [, n, u] of String(s).matchAll(/([\d.]+)(h|ms|m|s)/g)) ms += Number(n) * { h: 3600e3, m: 60e3, s: 1e3, ms: 1 }[u]
  return ms ? new Date(Date.now() + ms).toISOString() : null
}

function nextUtcMidnight() {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString()
}

// ---------------------------------------------------------------- all

/**
 * Meters for every connected AI: { id: { meters: [{label, pct, detail,
 * resetsAt}], note } }. `liveQuery`: an open Claude session, if any.
 */
export async function providerLimits(liveQuery) {
  const keys = readKeys()
  const out = {}
  await refreshClaude(liveQuery)
  const order = (k) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2)
  out.claude = {
    note: claude.plan ? `Claude ${claude.plan[0].toUpperCase()}${claude.plan.slice(1)}` : 'Plan limits appear after the first answer',
    meters: Object.entries(claude.windows)
      .filter(([, w]) => w.pct != null)
      .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
      .map(([k, w]) => ({ label: labelOf(k), pct: w.pct, resetsAt: w.resetsAt })),
  }
  const jobs = []
  if (keys.openrouter?.key) jobs.push(cached('openrouter', 60_000, () => openrouter(keys.openrouter.key)).then((v) => (out.openrouter = v)))
  if (keys.groq?.key) jobs.push(cached('groq', 10 * 60_000, () => groq(keys.groq.key)).then((v) => (out.groq = v)))
  await Promise.all(jobs)
  if (keys.gemini?.key) out.gemini = { meters: [], note: 'Google shares no usage figures for free keys' }
  out.local = { meters: [], note: 'Runs on this PC: no limit' }
  return out
}
