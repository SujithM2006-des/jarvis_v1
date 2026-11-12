/**
 * Which brain JARVIS thinks with: Claude over the internet, or a local model
 * in Ollama when the internet is gone.
 *
 * The Agent SDK talks to whatever speaks Anthropic's Messages API, and Ollama
 * does (http://127.0.0.1:11434). So going offline is the same agent with a
 * different address and model — plus a smaller tool set and a shorter brief,
 * because a small local model chokes on the full ones.
 *
 * Checked every 15 s by server.mjs; when the answer changes it drops the
 * windows' connections so each reconnects onto a session with the new brain.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const OLLAMA_URL = process.env.JARVIS_OLLAMA_URL ?? 'http://127.0.0.1:11434'

/** Local models in order of preference: fastest capable one first. */
const PREFERRED = [
  process.env.JARVIS_OFFLINE_MODEL,
  'qwen3:4b-instruct',
  'qwen3:4b-instruct-2507-q4_K_M',
  'qwen3:8b',
  'qwen3:4b',
  'llama3.1:8b',
  'qwen2.5:7b',
].filter(Boolean)

let state = { online: true, model: null, models: [], checkedAt: 0 }

/**
 * Is Anthropic's API reachable? Any HTTP answer counts; only no route does not.
 * JARVIS_BRAIN=local or =cloud forces the answer (to try offline mode while
 * online, or to never fall back).
 */
async function online() {
  if (process.env.JARVIS_BRAIN === 'local') return false
  if (process.env.JARVIS_BRAIN === 'cloud') return true
  // The same, switchable while running: ~/.jarvis/brain-override holding
  // "local" or "cloud" (delete it to go back to automatic).
  try {
    const o = readFileSync(join(homedir(), '.jarvis', 'brain-override'), 'utf8').trim()
    if (o === 'local') return false
    if (o === 'cloud') return true
  } catch {
    /* automatic */
  }
  try {
    await fetch('https://api.anthropic.com', { method: 'HEAD', signal: AbortSignal.timeout(3500) })
    return true
  } catch {
    return false
  }
}

async function ollamaModels() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) })
    const j = await r.json()
    return (j.models ?? []).map((m) => String(m.name))
  } catch {
    return []
  }
}

/** Look again; returns the new state. */
export async function checkBrain() {
  const [on, models] = await Promise.all([online(), ollamaModels()])
  const has = (name) => models.includes(name) || models.includes(`${name}:latest`)
  const model = PREFERRED.find(has) ?? models.find((m) => !/embed/i.test(m)) ?? null
  state = { online: on, model, models, checkedAt: Date.now() }
  return state
}

export const brainState = () => state

// ---------------------------------------------------------------------------
// Providers: which AI answers. Claude directly; Gemini, Groq and OpenRouter
// through LiteLLM (bridge/litellm.mjs), which speaks the same API as Claude to
// the agent and translates; the local model through Ollama.
// ---------------------------------------------------------------------------

export const PROVIDERS = {
  claude: { label: 'Claude', needs: 'internet' },
  // All three have free keys, easy to get (sign in with Google, no card).
  // Models are retired often (gemini-2.5-flash already was, for new users), so:
  // Gemini uses Google's always-current alias; Groq and OpenRouter pick a model
  // when the translator starts (litellm.mjs resolveModels), from what the
  // provider offers that day. A "model" in keys.json overrides either way.
  // The newest "gemini-N-flash" the key offers (the -latest alias was slow,
  // measured), thinking kept minimal: 5 s instead of 30+ for a short reply.
  gemini: { label: 'Gemini', needs: 'key', model: 'auto', prefix: 'gemini/' },
  groq: { label: 'Groq', needs: 'key', model: 'auto', prefix: 'groq/' },
  // Free (":free") models only: paid ones fail on a free account.
  openrouter: { label: 'OpenRouter', needs: 'key', model: 'auto', prefix: 'openrouter/' },
  local: { label: 'Local', needs: 'ollama' },
}
/**
 * Best first: the order Auto tries them in. Fastest measured first after
 * Claude: OpenRouter (free Nemotron) answered with a tool in 4.5 s, Gemini in
 * 38 s while Google's free tier was busy. Groq is known for speed.
 */
export const ORDER = ['claude', 'groq', 'openrouter', 'gemini', 'local']

const KEYS_FILE = join(homedir(), '.jarvis', 'keys.json')
const CHOICE_FILE = join(homedir(), '.jarvis', 'brain-choice')

/** API keys, from ~/.jarvis/keys.json — this PC only, never in the repository. */
export function readKeys() {
  try {
    return JSON.parse(readFileSync(KEYS_FILE, 'utf8').replace(/^﻿/, ''))
  } catch {
    return {}
  }
}
/** Keys with all but the last four characters hidden, for the setup screen. */
export function maskedKeys() {
  const k = readKeys()
  return Object.fromEntries(
    Object.keys(PROVIDERS)
      .filter((p) => PROVIDERS[p].needs === 'key')
      .map((p) => [p, k[p]?.key ? `••••${String(k[p].key).slice(-4)}` : '']),
  )
}
/**
 * Save keys from setup: a provider given a new key gets it, given "" keeps
 * what it had, given null loses it. Returns true if anything changed.
 */
export function saveKeys(input) {
  const k = readKeys()
  let changed = false
  for (const p of Object.keys(PROVIDERS)) {
    if (PROVIDERS[p].needs !== 'key' || !(p in (input ?? {}))) continue
    const v = input[p]
    if (v === null) {
      if (k[p]) changed = true
      delete k[p]
    } else if (typeof v === 'string' && v.trim() && !v.startsWith('••••')) {
      k[p] = { ...(k[p] ?? {}), key: v.trim().slice(0, 300) }
      changed = true
    }
  }
  if (changed) {
    mkdirSync(join(homedir(), '.jarvis'), { recursive: true })
    writeFileSync(KEYS_FILE, JSON.stringify(k, null, 2))
  }
  return changed
}

/** "auto" or a provider id, picked in the dropdown. */
export function readChoice() {
  try {
    const c = readFileSync(CHOICE_FILE, 'utf8').trim()
    return c in PROVIDERS ? c : 'auto'
  } catch {
    return 'auto'
  }
}
export function saveChoice(c) {
  writeFileSync(CHOICE_FILE, c in PROVIDERS ? c : 'auto')
}

/** Providers that hit a usage or rate limit, and until when to leave them. */
const exhausted = new Map()
export function markExhausted(id, minutes = 30) {
  exhausted.set(id, Date.now() + minutes * 60_000)
}
const isExhausted = (id) => (exhausted.get(id) ?? 0) > Date.now()

let proxyUp = () => false
/** server.mjs tells this how to know whether LiteLLM is running. */
export function setProxyCheck(fn) {
  proxyUp = fn
}

/** Can this provider answer right now? "" if yes, else why not. */
export function unavailable(id) {
  const p = PROVIDERS[id]
  if (!p) return 'unknown'
  if (p.needs === 'ollama') return state.model ? '' : 'no local model installed'
  if (!state.online) return 'offline'
  if (p.needs === 'key') {
    if (!readKeys()[id]?.key) return 'no API key — add one in Customize'
    if (!proxyUp()) return 'starting'
  }
  return ''
}

/** The provider to use now: the choice if it can answer, else the best that can. */
export function currentBrain() {
  const choice = readChoice()
  if (choice !== 'auto' && !unavailable(choice) && !isExhausted(choice)) return choice
  return ORDER.find((id) => !unavailable(id) && !isExhausted(id)) ?? ORDER.find((id) => !unavailable(id)) ?? null
}

/** Everything the dropdown shows. */
export function brainsInfo() {
  const active = currentBrain()
  return {
    choice: readChoice(),
    active,
    activeLabel: active ? PROVIDERS[active].label + (active === 'local' && state.model ? ` (${state.model})` : '') : 'None',
    options: ORDER.map((id) => ({
      id,
      label: PROVIDERS[id].label,
      unavailable: unavailable(id) || (isExhausted(id) ? 'limit reached — resting' : ''),
    })),
  }
}

/** The model name LiteLLM serves a provider under (see litellm.mjs). */
export const proxyModel = (id) => `jarvis-${id}`

/** Run on the local model now? */
export const useLocal = () => currentBrain() === 'local'

/**
 * Online or not, for the voice: "local" when offline on the local model (the
 * wake listener then hears commands itself), "cloud" online, "none" offline
 * with no local model.
 */
export const brainMode = () => (state.online ? 'cloud' : state.model ? 'local' : 'none')

/** Environment for the agent's process when it runs on Ollama. */
export function localEnv() {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: OLLAMA_URL,
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: '',
    // Its title/summary side-requests would go to the same small model; skip them.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

/**
 * Offline answers that need no model at all — the local one takes tens of
 * seconds even for "what time is it". Only plain questions about here and
 * now; anything more ("time in London", "what time is my meeting") goes to
 * the model. Returns the answer, or null.
 */
export function quickAnswer(said) {
  const t = String(said).replace(/^\[.*?\]\s*/, '').toLowerCase().replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim()
  if (t.length > 60 || /\b(in|at|for|my|meeting|until|till|since|left)\b/.test(t.replace(/^(hey |ok |okay )?jarvis /, ''))) return null
  const now = new Date()
  if (/\b(what('?s| is)?( the)? time|time is it|current time|tell me the time|time now|the time)\b/.test(t)) {
    return `It's ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`
  }
  if (/\b(what('?s| is)?( the| today'?s)? date|today'?s date|what day is (it|today)|which day is (it|today))\b/.test(t)) {
    return `It's ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`
  }
  return null
}

const FOLDERS = {
  download: 'downloads', downloads: 'downloads', document: 'documents', documents: 'documents',
  desktop: 'desktop', picture: 'pictures', pictures: 'pictures', photos: 'pictures', music: 'music',
  video: 'videos', videos: 'videos', home: 'home', 'this pc': 'this pc', 'my computer': 'this pc',
  'recycle bin': 'recycle bin', onedrive: 'onedrive', 'file explorer': '', explorer: '', files: '',
}

/** "report in downloads" -> "downloads\report"; a plain name or path as it is. */
function placeOf(name, where) {
  const n = name.trim().replace(/^["']|["']$/g, '')
  return where ? `${where.trim()}\\${n}` : n
}

/**
 * Plain PC commands, run straight away with the PC tools — no model. Offline,
 * the local model takes tens of seconds to decide that "open notepad" means
 * open_app; this takes a fraction of a second. Anything not recognised (or a
 * tool that fails, say a file that is not where it was named) goes on to the
 * model, which can search and ask.
 *
 * `run(name, args)` calls a PC tool: { text, failed } or null if that tool is
 * not available (write tools when writes are off). Returns
 * { say, tool } or null.
 */
export async function quickCommand(said, run) {
  let t = String(said).replace(/^\[.*?\]\s*/, '').trim().replace(/[.!?]+$/, '')
  // Drop the name and the politeness around the command.
  t = t.replace(/^(hey |ok |okay )?(jarvis|j\.a\.r\.v\.i\.s\.?)[,\s]*/i, '')
  for (let i = 0; i < 3; i++) t = t.replace(/^(please|can you|could you|would you|will you|kindly|just|now)\s+/i, '')
  t = t.replace(/\s+(please|for me|now|right now)$/i, '').trim()
  if (!t || t.length > 160) return null
  const lo = t.toLowerCase()
  let m

  const go = async (tool, args, fallThroughOnFail = true) => {
    const r = await run(tool, args)
    if (!r) return null
    if (r.failed && fallThroughOnFail) return null
    // Spoken, so a full path becomes just its name ("C:\Users\…\x.zip" -> "x.zip"),
    // and the zip tool's housekeeping note is left off.
    const say = (r.text || 'Done.')
      .replace(/[A-Za-z]:\\[^\s"']*\\([^\\\s"']+)/g, '$1')
      .replace(/\s*Left out node_modules.*?caches\.\s*Secrets \(\.env, keys\) were left out\./, '')
      .trim()
    return { say, tool }
  }

  // Volume, media, lock.
  if (/^(turn (the )?volume up|volume up|increase (the )?volume|louder|turn it up)$/.test(lo)) return go('media_control', { action: 'volume_up', times: 5 })
  if (/^(turn (the )?volume down|volume down|decrease (the )?volume|lower (the )?volume|quieter|turn it down)$/.test(lo)) return go('media_control', { action: 'volume_down', times: 5 })
  if (/^(mute|unmute)( the)?( sound| volume| audio)?$/.test(lo)) return go('media_control', { action: 'mute' })
  if (/^(pause|play|resume)( the)?( music| song| media| video)?$/.test(lo)) return go('media_control', { action: 'play_pause' })
  if (/^(next|skip)( the)?( song| track)?$/.test(lo)) return go('media_control', { action: 'next' })
  if (/^(previous|last)( song| track)$/.test(lo)) return go('media_control', { action: 'previous' })
  if (/^lock( the| my)? (pc|computer|laptop|screen)$/.test(lo)) return go('lock_pc', {})

  // A sentence, not a name ("open the file I was working on and summarise
  // it"): that needs the model's judgement, not the fast path.
  const sentence = (s) => s.split(/\s+/).length > 4 || /\b(and|then|that|which|who|i|it|was|were|yesterday|today|last|summar\w*|read|tell)\b/i.test(s)

  // Open a folder or an app. An app it cannot find goes on to the model,
  // which can look for a file or folder of that name instead.
  if ((m = t.match(/^(?:open|launch|start|run|show)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:app|application|folder))?$/i))) {
    const target = m[1].trim()
    const key = target.toLowerCase()
    if (key in FOLDERS) return go('open_folder', FOLDERS[key] ? { path: FOLDERS[key] } : {}, false)
    if (/[\\/]|^[a-z]:/i.test(target)) return go('open_folder', { path: target })
    if (sentence(target)) return null
    return go('open_app', { name: target })
  }
  // Close an app.
  if ((m = t.match(/^(?:close|quit|exit)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:app|application|window))?$/i))) {
    if (sentence(m[1])) return null
    return go('close_app', { name: m[1].trim() }, false)
  }
  // Zip: "zip the reports folder in downloads (to desktop)".
  if ((m = t.match(/^(?:zip|compress)\s+(?:up\s+)?(?:the\s+|my\s+)?(.+?)(?:\s+(?:folder|file|directory))?(?:\s+(?:in|from|on)\s+(?:the\s+|my\s+)?([^]+?))?(?:\s+(?:to|into|and save (?:it )?(?:to|in))\s+(?:the\s+|my\s+)?(.+))?$/i))) {
    const args = { source: placeOf(m[1], m[2]) }
    if (m[3]) args.destination = m[3].trim()
    return go('zip_files', args)
  }
  // Copy / move: "copy notes.txt in documents to desktop".
  if ((m = t.match(/^(copy|move)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:folder|file))?(?:\s+(?:in|from|on)\s+(?:the\s+|my\s+)?(.+?))?\s+(?:to|into)\s+(?:the\s+|my\s+)?(.+)$/i))) {
    return go('file_operation', { action: m[1].toLowerCase(), source: placeOf(m[2], m[3]), destination: m[4].trim() })
  }
  // Rename: "rename notes.txt in documents to old notes.txt".
  if ((m = t.match(/^rename\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:in|on)\s+(?:the\s+|my\s+)?(.+?))?\s+to\s+(.+)$/i))) {
    return go('file_operation', { action: 'rename', source: placeOf(m[1], m[2]), destination: m[3].trim() })
  }
  // New folder: "create a folder called projects in documents" (desktop if no place).
  if ((m = t.match(/^(?:create|make)\s+(?:a\s+)?(?:new\s+)?folder\s+(?:called|named)\s+(.+?)(?:\s+(?:in|on)\s+(?:the\s+|my\s+)?(.+))?$/i))) {
    return go('file_operation', { action: 'new_folder', source: placeOf(m[1], m[2] || 'desktop') })
  }
  return null
}

/** The brief for the local model: short, because every word costs it time. */
export const OFFLINE_PROMPT = `You are offline right now, running on a small local model on this PC, so:
- Answer in one or two short spoken sentences. No lists, no markdown.
- Use a tool only when the request needs one: opening apps or folders, files,
  documents, reminders and the calendar, memory, the time, volume.
- There is no internet: weather, web search, WhatsApp, email and anything
  online are unavailable — say so in one sentence if asked, and that it will
  work again when the internet is back.
- Never invent a tool result. If a tool fails, say so plainly.

`
