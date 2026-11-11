/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { appendFileSync, cpSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

/**
 * The same, for the ONNX runtime behind the Kokoro voice. transformers.js
 * otherwise imports it from cdn.jsdelivr.net, the CSP blocks that, and JARVIS
 * silently falls back to the robotic system voice. Copied from the
 * transformers package itself so the runtime matches the version it expects.
 */
function vendorOrt() {
  const from = 'node_modules/@huggingface/transformers/dist'
  const to = 'public/ort'
  const files = [
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
  ]
  if (!existsSync(`${from}/${files[0]}`)) return
  try {
    mkdirSync(to, { recursive: true })
    for (const f of files) {
      if (!existsSync(`${to}/${f}`)) cpSync(`${from}/${f}`, `${to}/${f}`)
    }
  } catch (err) {
    console.warn(`  could not vendor the voice runtime: ${err.message}`)
  }
}

const writes = process.argv.includes('--writes')

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

/**
 * Everything printed is also appended to ~/.jarvis/jarvis.log (colour codes
 * stripped), so a session that went wrong can be read back afterwards even
 * when the console window it ran in is long gone.
 */
// Your own look files (gitignored), made from the shipped defaults if missing.
try {
  const { ensureCustom } = await import('./ensure-custom.mjs')
  const made = ensureCustom()
  if (made.length) console.log(`custom look: made ${made.join(', ')} from the defaults`)
} catch {
  /* never a reason not to start */
}

const LOG_FILE = join(homedir(), '.jarvis', 'jarvis.log')
try {
  mkdirSync(dirname(LOG_FILE), { recursive: true })
  // Rotate past 5 MB, keeping one previous file: the log records every voice
  // command, and left alone it grew without limit.
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 5 * 1024 * 1024) {
    renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.old.log'))
  }
  appendFileSync(LOG_FILE, `\n===== ${new Date().toLocaleString()} start ${process.argv.slice(2).join(' ')} =====\n`)
} catch {
  /* logging is a convenience, never a reason not to start */
}
const toLog = (text) => {
  try {
    appendFileSync(LOG_FILE, String(text).replace(/\x1b\[[0-9;]*m/g, '') + '\n')
  } catch {
    /* ignore */
  }
}
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream)
  stream.write = (chunk, ...rest) => {
    toLog(String(chunk).replace(/\n$/, ''))
    return write(chunk, ...rest)
  }
}

const children = []

/** Crash restarts allowed in a window, before giving up for good. */
const RESTARTS = 5
const RESTART_WINDOW_MS = 10 * 60 * 1000

function run(name, command, args, colour, env, { restart = false } = {}) {
  const label = paint(name, colour)
  const crashes = []
  const start = () => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      shell: false,
    })
    child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
    child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
    child.on('exit', (code) => {
      const i = children.indexOf(child)
      if (i >= 0) children.splice(i, 1)
      if (stopping) return
      // The bridge comes back on its own after a crash — the window
      // reconnects by itself — rather than taking the whole app down with it.
      // Only a run of crashes stops everything, so a broken bridge cannot spin.
      const now = Date.now()
      while (crashes.length && now - crashes[0] > RESTART_WINDOW_MS) crashes.shift()
      if (restart && code !== 0 && crashes.length < RESTARTS) {
        crashes.push(now)
        console.log(`\x1b[${colour}m${name}\x1b[0m crashed (${code}); restarting (${crashes.length}/${RESTARTS}).`)
        setTimeout(() => {
          if (!stopping) start()
        }, 2000)
        return
      }
      // Otherwise the other half is useless without it: take the whole thing
      // down rather than leave a half-running app that cannot answer.
      console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); stopping the rest.`)
      shutdown(code ?? 0)
    })
    children.push(child)
    return child
  }
  return start()
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every MCP server on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing, because the handshake is being 403'd
 * somewhere neither half reports. Passing the port through closes that gap
 * without widening what the bridge trusts by default.
 */
const port = process.env.PORT
const bridgeEnv = writes ? { JARVIS_ALLOW_WRITES: '1' } : {}
if (port) {
  bridgeEnv.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
}

vendorWasm()
vendorOrt()

console.log('\nJ.A.R.V.I.S. starting — the brain and the face.\n')
run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv, { restart: true })
// npm is a shell script on most systems; call the vite binary directly so we do
// not need shell:true (which would break the argument handling above).
run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', {})

console.log(
  '\nWhen it says the dev server is ready, open the URL it prints in Chrome,\n' +
    'click INITIALISE, and say "Hey Jarvis". Ctrl-C stops everything.\n',
)
