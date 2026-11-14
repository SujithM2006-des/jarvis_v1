/**
 * Model usage: how much each AI has been used, for the Model Usage box.
 *
 * Every finished answer adds its tokens to today's line for the AI that gave
 * it (Claude, Gemini, Groq, OpenRouter or the offline model); a limit hit is
 * counted too. Kept in ~/.jarvis/usage.json, 30 days, nothing else.
 *
 *   { "days": { "2026-11-14": { "claude": { "requests": 12, "input": 3400,
 *       "output": 910, "cached": 51000, "cost": 0.21, "limits": 0 } } } }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const FILE = join(homedir(), '.jarvis', 'usage.json')
const KEEP_DAYS = 30

const day = (d = new Date()) => {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

function load() {
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8'))
    if (data && typeof data.days === 'object') return data
  } catch {
    /* none yet, or damaged: start again */
  }
  return { days: {} }
}

let data = load()
let saveTimer = null

function save() {
  // Several answers can finish close together: write once they settle.
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      const keep = Object.keys(data.days).sort().slice(-KEEP_DAYS)
      data.days = Object.fromEntries(keep.map((k) => [k, data.days[k]]))
      if (!existsSync(dirname(FILE))) mkdirSync(dirname(FILE), { recursive: true })
      writeFileSync(FILE, JSON.stringify(data))
    } catch (err) {
      console.log(`[jarvis] could not save usage: ${err.message}`)
    }
  }, 1000)
}

function line(brain) {
  const today = (data.days[day()] ??= {})
  return (today[brain] ??= { requests: 0, input: 0, output: 0, cached: 0, cost: 0, limits: 0 })
}

/** One finished answer: its token counts (the SDK's `usage`) and cost. */
export function recordUsage(brain, usage = {}, costUsd = null) {
  const l = line(brain || 'claude')
  l.requests += 1
  l.input += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  l.output += usage.output_tokens ?? 0
  l.cached += usage.cache_read_input_tokens ?? 0
  if (typeof costUsd === 'number' && Number.isFinite(costUsd)) l.cost += costUsd
  save()
}

/** A provider said its limit was reached. */
export function recordLimit(brain) {
  line(brain || 'claude').limits += 1
  save()
}

/** Today's and the last 7 days' totals, per AI. */
export function usageInfo() {
  const today = data.days[day()] ?? {}
  const week = {}
  for (let i = 0; i < 7; i++) {
    const d = data.days[day(new Date(Date.now() - i * 86_400_000))] ?? {}
    for (const [brain, l] of Object.entries(d)) {
      const w = (week[brain] ??= { requests: 0, input: 0, output: 0, cached: 0, cost: 0, limits: 0 })
      for (const k of Object.keys(w)) w[k] += l[k] ?? 0
    }
  }
  return { day: day(), today, week }
}
