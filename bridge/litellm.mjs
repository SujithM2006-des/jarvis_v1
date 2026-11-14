/**
 * LiteLLM: the translator that lets Gemini, Groq and OpenRouter drive
 * JARVIS's agent. The agent speaks Anthropic's Messages API; LiteLLM serves
 * that same API on 127.0.0.1:4000 and translates each request — tool calls
 * included — for the provider behind the model name ("jarvis-gemini" etc.).
 *
 * Runs from the wake listener's Python environment (pip install
 * "litellm[proxy]"), only while at least one provider key is set, and is
 * restarted when the keys change. Its master key is made fresh each start and
 * never leaves this PC; the provider keys come from ~/.jarvis/keys.json.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OLLAMA_URL, PROVIDERS, brainState, proxyModel, readKeys } from './brain.mjs'

export const PROXY_PORT = Number(process.env.JARVIS_LITELLM_PORT ?? 4000)
export const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`

const DIR = join(homedir(), '.jarvis')
const CONFIG = join(DIR, 'litellm.yaml')
const EXE = join(DIR, 'wake-venv', 'Scripts', process.platform === 'win32' ? 'litellm.exe' : 'litellm')

let proc = null
let up = false
let masterKey = ''

export const proxyIsUp = () => up
export const proxyKey = () => masterKey
export const proxyInstalled = () => existsSync(EXE)

/** YAML string, quoted safely. */
const q = (s) => JSON.stringify(String(s))

/** First model in `ids` matching the preferences in order, else the first. */
function prefer(ids, prefs) {
  for (const p of prefs) {
    const hit = ids.find((id) => (typeof p === 'string' ? id === p : p.test(id)))
    if (hit) return hit
  }
  return ids[0] ?? null
}

/**
 * Today's model for the providers set to "auto": what they actually offer,
 * best first — so a retired model never breaks them.
 */
const resolved = {}

/** The model a provider is served with (for the usage meters), or null. */
export const resolvedModel = (id) => readKeys()[id]?.model || resolved[id] || null
async function resolveModels(keys) {
  if (keys.openrouter?.key && !keys.openrouter.model) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(8000) })
      const free = ((await r.json()).data ?? [])
        .filter((m) => String(m.id).endsWith(':free') && (m.supported_parameters ?? []).includes('tools'))
        .map((m) => m.id)
      // Up to three, each backing up the one before: free models are often
      // rate-limited ("429 … rate-limited upstream", measured on Gemma, which
      // shares Google's busy pool), so a non-Google model leads.
      const prefs = [/nemotron-3\.5-super/, /gemma-4-31b/, /nemotron.*ultra/, /inkling/, /gemma-4/, /nemotron/, /llama.*70b/]
      const chain = []
      for (const p of prefs) {
        const hit = free.find((id) => p.test(id) && !chain.includes(id))
        if (hit) chain.push(hit)
        if (chain.length === 3) break
      }
      if (chain.length < 3) chain.push(...free.filter((id) => !chain.includes(id)).slice(0, 3 - chain.length))
      if (chain[0]) {
        resolved.openrouter = chain[0]
        resolved.openrouterBackups = chain.slice(1)
      }
    } catch {
      /* keep the last pick */
    }
  }
  if (keys.gemini?.key && !keys.gemini.model) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(keys.gemini.key)}`, {
        signal: AbortSignal.timeout(8000),
      })
      // Plain "gemini-<version>-flash" models, newest version first — but
      // the very newest is often overloaded on the free tier ("503 high
      // demand", measured on 3.8), so the proven 3.5 comes first while it
      // exists. A Flash-Lite backs it up when Google says it is busy.
      const ids = ((await r.json()).models ?? []).map((m) => String(m.name).replace(/^models\//, ''))
      const byVersion = (re) =>
        ids.filter((id) => re.test(id)).sort((a, b) => parseFloat(b.split('-')[1]) - parseFloat(a.split('-')[1]))
      const flash = byVersion(/^gemini-\d+(\.\d+)?-flash$/)
      const lite = byVersion(/^gemini-\d+(\.\d+)?-flash-lite$/)
      resolved.gemini = prefer(flash, ['gemini-3.5-flash']) ?? resolved.gemini
      resolved.geminiLite = prefer(lite, ['gemini-3.1-flash-lite']) ?? resolved.geminiLite
    } catch {
      /* keep the last pick */
    }
    resolved.gemini ??= 'gemini-3.5-flash'
  }
  if (keys.groq?.key && !keys.groq.model) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { authorization: `Bearer ${keys.groq.key}` },
        signal: AbortSignal.timeout(8000),
      })
      const ids = ((await r.json()).data ?? [])
        .map((m) => String(m.id))
        .filter((id) => !/whisper|guard|tts|playai|embed|compound|vision|distil/i.test(id))
      const pick = prefer(ids, [/llama-4.*maverick/i, /llama-3\.3-70b/i, /gpt-oss-120b/i, /llama.*70b/i, /qwen.*32b/i, /llama/i])
      if (pick) resolved.groq = pick
    } catch {
      /* keep the last pick */
    }
  }
}

function writeConfig() {
  const keys = readKeys()
  const lines = ['model_list:']
  let any = false
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (p.needs !== 'key' || !keys[id]?.key) continue
    const model = keys[id].model || (p.model === 'auto' ? resolved[id] : p.model)
    if (!model) {
      console.log(`[jarvis] ${p.label}: no usable model found - check the key`)
      continue
    }
    any = true
    console.log(`[jarvis] ${p.label} model: ${model}`)
    lines.push(
      `  - model_name: ${q(proxyModel(id))}`,
      `    litellm_params:`,
      `      model: ${q(model.startsWith(p.prefix) ? model : p.prefix + model)}`,
      `      api_key: ${q(keys[id].key)}`,
      // A provider that stops answering is treated like one out of quota:
      // fail in 40 s so JARVIS can move to the next instead of hanging.
      `      timeout: 40`,
      ...(id === 'gemini' ? [`      reasoning_effort: "minimal"`] : []),
    )
  }
  // Gemini's backup: when its main model is busy, the translator retries on
  // Flash-Lite before JARVIS has to switch providers at all.
  const fallbacks = []
  if (keys.gemini?.key && !keys.gemini.model && resolved.geminiLite) {
    lines.push(
      `  - model_name: ${q(proxyModel('gemini') + '-lite')}`,
      `    litellm_params:`,
      `      model: ${q('gemini/' + resolved.geminiLite)}`,
      `      api_key: ${q(keys.gemini.key)}`,
      `      timeout: 40`,
      `      reasoning_effort: "minimal"`,
    )
    fallbacks.push(`    - ${q(proxyModel('gemini'))}: [${q(proxyModel('gemini') + '-lite')}]`)
  }
  // OpenRouter's backups: other free models, tried in turn when one is busy.
  if (keys.openrouter?.key && !keys.openrouter.model && resolved.openrouterBackups?.length) {
    const names = resolved.openrouterBackups.map((m, i) => {
      const name = `${proxyModel('openrouter')}-${i + 2}`
      lines.push(
        `  - model_name: ${q(name)}`,
        `    litellm_params:`,
        `      model: ${q('openrouter/' + m)}`,
        `      api_key: ${q(keys.openrouter.key)}`,
        `      timeout: 40`,
      )
      return q(name)
    })
    fallbacks.push(`    - ${q(proxyModel('openrouter'))}: [${names.join(', ')}]`)
  }
  // The local model through the same translator: lets the path be tested
  // with no provider keys at all.
  if (brainState().model) {
    lines.push(
      `  - model_name: ${q(proxyModel('local-test'))}`,
      `    litellm_params:`,
      `      model: ${q('ollama_chat/' + brainState().model)}`,
      `      api_base: ${q(OLLAMA_URL)}`,
    )
  }
  lines.push('litellm_settings:', '  drop_params: true', '  num_retries: 0')
  if (fallbacks.length) lines.push('router_settings:', '  fallbacks:', ...fallbacks)
  mkdirSync(DIR, { recursive: true })
  writeFileSync(CONFIG, lines.join('\n') + '\n')
  return any
}

async function healthy() {
  try {
    const r = await fetch(`${PROXY_URL}/health/liveliness`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

export function stopProxy() {
  up = false
  if (proc) {
    try {
      proc.kill()
    } catch {
      /* gone */
    }
    proc = null
  }
}

/**
 * Start (or restart) LiteLLM for the current keys. `force` starts it even with
 * no keys (to test through the local model). Resolves true once it answers.
 */
export async function startProxy({ force = false } = {}) {
  stopProxy()
  if (!proxyInstalled()) {
    console.log('[jarvis] LiteLLM not installed - Gemini/Groq/OpenRouter unavailable')
    return false
  }
  await resolveModels(readKeys())
  const anyKey = writeConfig()
  if (!anyKey && !force) return false
  masterKey = `sk-jarvis-${randomBytes(18).toString('hex')}`
  // No database: LiteLLM reads DATABASE_URL (set for some other project on
  // this PC) as a request to keep one, and exits when it cannot set it up.
  const env = { ...process.env, LITELLM_MASTER_KEY: masterKey, LITELLM_LOG: 'ERROR', PYTHONIOENCODING: 'utf-8' }
  delete env.DATABASE_URL
  delete env.DIRECT_URL
  proc = spawn(EXE, ['--config', CONFIG, '--host', '127.0.0.1', '--port', String(PROXY_PORT)], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let err = ''
  proc.stderr.on('data', (d) => {
    err = (err + d).slice(-2000)
  })
  const mine = proc
  proc.on('exit', (code) => {
    if (proc === mine) {
      proc = null
      up = false
      if (code) console.log(`[jarvis] LiteLLM stopped (${code}): ${err.trim().split('\n').slice(-2).join(' ')}`)
    }
  })
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (proc !== mine) return false
    if (await healthy()) {
      up = true
      console.log(`[jarvis] LiteLLM ready on ${PROXY_URL}`)
      return true
    }
  }
  console.log('[jarvis] LiteLLM did not start in 30 s')
  return false
}
