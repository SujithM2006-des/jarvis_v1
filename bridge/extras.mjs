/**
 * More everyday skills, for every brain:
 *
 *   read_text_in_image   OCR of a picture, or of the screen — Windows' own, offline
 *   make_qr_code         a QR code for a link, Wi-Fi network, phone number or text
 *   youtube_transcript   a YouTube video's captions, to summarise or quote it
 *   route_distance       road distance and driving time between two places (OpenStreetMap)
 *   convert_currency     live exchange rates (European Central Bank data)
 *   define_word          meaning, pronunciation, examples, synonyms
 *   organize_folder      sort a folder's loose files into subfolders by type, with undo
 *   undo_organize        put them back
 *   add_routine / list_routines / remove_routine
 *                        a request JARVIS carries out by himself at a time
 *                        ("every morning at 8, brief me on the news")
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const EXTRA_WRITE_TOOLS = new Set(['make_qr_code', 'organize_folder', 'undo_organize', 'add_routine', 'remove_routine'])

const HOME = homedir()
const SCRIPTS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'scripts')
const PY = join(HOME, '.jarvis', 'wake-venv', 'Scripts', 'python.exe')
const ROUTINES = join(HOME, '.jarvis', 'routines.json')
const UA = 'JARVIS-assistant/1.0 (personal desktop assistant)'

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const failText = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const openFile = (f) => spawn('cmd.exe', ['/c', 'start', '""', f], { detached: true, stdio: 'ignore', windowsHide: true }).unref()

function run(file, args, timeoutMs = 60_000, env) {
  return new Promise((res, rej) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: env ?? process.env }, (err, stdout, stderr) => {
      if (err) return rej(new Error(String(stderr || err.message).trim().split('\n').slice(-4).join(' ')))
      res(String(stdout))
    })
  })
}
const getJson = async (url) => {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error(`the service answered ${r.status}`)
  return r.json()
}

// ---------------------------------------------------------------- OCR

/** A screenshot of the whole screen to a temporary PNG (only when asked to read the screen). */
async function grabScreen() {
  const f = join(tmpdir(), `jarvis-screen-${stamp()}.png`)
  await run(
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing; ' +
        '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; ' +
        '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; ' +
        '$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); ' +
        '$bmp.Save($env:J_OUT, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()',
    ],
    30_000,
    { ...process.env, J_OUT: f },
  )
  return f
}

export async function ocr(image) {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(SCRIPTS, 'ocr.ps1'), '-Path', image], 60_000)
  return out.replace(/\r/g, '').trim()
}

// ---------------------------------------------------------------- organise

const TYPES = {
  Images: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.heic', '.ico', '.tiff'],
  Videos: ['.mp4', '.mkv', '.mov', '.avi', '.webm', '.wmv', '.flv', '.3gp'],
  Music: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma'],
  Documents: ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.md', '.epub'],
  Spreadsheets: ['.xls', '.xlsx', '.csv', '.ods'],
  Presentations: ['.ppt', '.pptx', '.odp', '.key'],
  Archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.iso'],
  Programs: ['.exe', '.msi', '.apk', '.msix', '.appx'],
  Code: ['.js', '.ts', '.py', '.java', '.c', '.cpp', '.cs', '.html', '.css', '.json', '.ipynb', '.sql', '.sh', '.ps1'],
}
const typeOf = (f) => Object.entries(TYPES).find(([, exts]) => exts.includes(extname(f).toLowerCase()))?.[0] ?? 'Other'
const undoFile = (dir) => join(dir, '.jarvis-organize-undo.json')

// ---------------------------------------------------------------- routines

function readRoutines() {
  try {
    return JSON.parse(readFileSync(ROUTINES, 'utf8'))
  } catch {
    return []
  }
}
const writeRoutines = (r) => {
  mkdirSync(join(HOME, '.jarvis'), { recursive: true })
  writeFileSync(ROUTINES, JSON.stringify(r, null, 2))
}
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/**
 * Every 30 s: a routine whose time has come today (and whose day it is) is
 * handed to `runRequest` — the bridge asks it as if typed in the popup — once
 * a day. Missed while JARVIS was off: not run late (a 7 am briefing at noon is
 * noise), except within 10 minutes.
 */
export function startRoutines(runRequest) {
  setInterval(() => {
    const now = new Date()
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
    const hm = now.getHours() * 60 + now.getMinutes()
    const list = readRoutines()
    let changed = false
    for (const r of list) {
      const [h, m] = r.time.split(':').map(Number)
      const due = h * 60 + m
      const dayOk = !r.days?.length || r.days.includes(DAYS[now.getDay()])
      if (dayOk && r.lastRun !== today && hm >= due && hm - due <= 10) {
        if (runRequest(r.request)) {
          r.lastRun = today
          changed = true
          console.log(`[jarvis] routine ran: ${r.time} ${r.request}`)
        }
      }
    }
    if (changed) writeRoutines(list)
  }, 30_000).unref()
}

// ---------------------------------------------------------------- the tools

export function extrasServer() {
  return createSdkMcpServer({
    name: 'jarvis_extras',
    version: '1.0.0',
    instructions: 'OCR, QR codes, YouTube captions, routes, currency, dictionary, folder tidying, routines.',
    tools: [
      tool(
        'read_text_in_image',
        "Read the text in a picture (a photo of a bill, a screenshot, a scanned page) with Windows' " +
          'own OCR — offline. Give `path`, or screen: true to read what is on the screen now (only ' +
          'when the user asks to read the screen).',
        { path: z.string().optional(), screen: z.boolean().optional() },
        async ({ path, screen }) => {
          let shot = null
          try {
            const img = screen ? (shot = await grabScreen()) : path
            if (!img || !existsSync(img)) return failText(path ? `No image at ${path}.` : 'Give an image path, or screen: true.')
            const t = await ocr(img)
            return text(t || 'No text found in the image.')
          } catch (err) {
            return failText(`Could not read the text: ${err.message}`)
          } finally {
            if (shot) rmSync(shot, { force: true })
          }
        },
      ),
      tool(
        'make_qr_code',
        'Make a QR code (PNG in Pictures\\Jarvis, opened). content: a link, plain text, "tel:+91…", ' +
          'or Wi-Fi as wifi {ssid, password, security "WPA"|"WEP"|"nopass"}.',
        {
          content: z.string().optional(),
          wifi: z.object({ ssid: z.string(), password: z.string().optional(), security: z.string().optional() }).optional(),
          name: z.string().optional(),
        },
        async ({ content, wifi, name }) => {
          const esc = (s) => String(s ?? '').replace(/([\\;,:"])/g, '\\$1')
          const data = wifi ? `WIFI:T:${wifi.security || 'WPA'};S:${esc(wifi.ssid)};P:${esc(wifi.password)};;` : content
          if (!data) return failText('Nothing to encode.')
          const dir = join(HOME, 'Pictures', 'Jarvis')
          mkdirSync(dir, { recursive: true })
          const f = join(dir, `${String(name ?? `qr ${stamp()}`).replace(/[\\/:*?"<>|]+/g, ' ').trim()}.png`)
          try {
            await run(PY, ['-I', '-c', 'import os, qrcode; qrcode.make(os.environ["J_DATA"], box_size=12, border=3).save(os.environ["J_OUT"])'], 30_000, {
              ...process.env,
              J_DATA: data,
              J_OUT: f,
            })
            openFile(f)
            return text(`QR code saved: ${f}`)
          } catch (err) {
            return failText(`Could not make the QR code: ${err.message}`)
          }
        },
      ),
      tool(
        'youtube_transcript',
        "A YouTube video's captions as text (English, Hindi or Tamil, else whatever it has), to " +
          'summarise it, answer questions about it or quote it.',
        { url: z.string().describe('The video link or its ID'), max_chars: z.number().optional().describe('Default 15000') },
        async ({ url, max_chars = 15000 }) => {
          const id = (String(url).match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/) ?? [])[1] ?? (/^[\w-]{11}$/.test(url) ? url : null)
          if (!id) return failText('That does not look like a YouTube link.')
          const code =
            'import os, sys\nsys.stdout.reconfigure(encoding="utf-8")\n' +
            'from youtube_transcript_api import YouTubeTranscriptApi as A\n' +
            'api = A()\nvid = os.environ["J_ID"]\n' +
            'try:\n    t = api.fetch(vid, languages=["en", "en-IN", "hi", "ta"])\n' +
            'except Exception:\n    t = next(iter(api.list(vid))).fetch()\n' +
            'print(" ".join(s.text.replace("\\n", " ") for s in t))'
          try {
            const out = (await run(PY, ['-I', '-c', code], 60_000, { ...process.env, J_ID: id })).trim()
            if (!out) return failText('This video has no captions.')
            const cap = Math.min(60000, Math.max(2000, max_chars))
            return text(out.slice(0, cap) + (out.length > cap ? ' …(cut)' : ''))
          } catch (err) {
            return failText(`No captions available for this video (${err.message.slice(0, 120)}).`)
          }
        },
      ),
      tool(
        'route_distance',
        'Road distance and driving time between two places (OpenStreetMap), plus the straight-line ' +
          'distance. Places as names ("Namakkal", "Chennai Central") or addresses.',
        { from: z.string(), to: z.string() },
        async ({ from, to }) => {
          try {
            const place = async (q) => {
              const r = await getJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`)
              if (!r[0]) throw new Error(`could not find "${q}"`)
              return { lat: Number(r[0].lat), lon: Number(r[0].lon), name: r[0].display_name.split(',').slice(0, 3).join(',') }
            }
            const a = await place(from)
            const b = await place(to)
            const rad = (d) => (d * Math.PI) / 180
            const air = 6371 * 2 * Math.asin(Math.sqrt(Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2))
            const r = await getJson(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`)
            const route = r.routes?.[0]
            const time = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`)
            return text(
              `${a.name} → ${b.name}: ` +
                (route ? `${(route.distance / 1000).toFixed(0)} km by road, about ${time(route.duration)} driving (without traffic). ` : 'no road route found. ') +
                `Straight line: ${air.toFixed(0)} km.`,
            )
          } catch (err) {
            return failText(`Could not work out the route: ${err.message}`)
          }
        },
      ),
      tool(
        'convert_currency',
        'Convert money with live exchange rates (European Central Bank, updated daily). Codes like INR, USD, EUR, GBP, AED, JPY.',
        { amount: z.number(), from: z.string(), to: z.string() },
        async ({ amount, from, to }) => {
          try {
            const f = from.trim().toUpperCase()
            const t = to.trim().toUpperCase()
            const r = await getJson(`https://api.frankfurter.dev/v1/latest?base=${f}&symbols=${t}`)
            const rate = r.rates?.[t]
            if (!rate) return failText(`No rate for ${f} to ${t}.`)
            const v = amount * rate
            return text(`${amount.toLocaleString('en-IN')} ${f} = ${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${t} (rate ${rate}, ${r.date}).`)
          } catch (err) {
            return failText(`Could not convert: ${err.message}`)
          }
        },
      ),
      tool(
        'define_word',
        'An English word: meanings by part of speech, pronunciation, an example, synonyms.',
        { word: z.string() },
        async ({ word }) => {
          try {
            const r = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.trim())}`)
            const e = r[0]
            const lines = [`${e.word} ${e.phonetic ?? e.phonetics?.find((p) => p.text)?.text ?? ''}`.trim()]
            for (const m of e.meanings.slice(0, 3)) {
              const d = m.definitions[0]
              lines.push(`(${m.partOfSpeech}) ${d.definition}${d.example ? ` — e.g. "${d.example}"` : ''}`)
              const syn = [...(m.synonyms ?? []), ...(d.synonyms ?? [])].slice(0, 5)
              if (syn.length) lines.push(`  synonyms: ${syn.join(', ')}`)
            }
            return text(lines.join('\n'))
          } catch {
            return failText(`"${word}" is not in the dictionary.`)
          }
        },
      ),
      tool(
        'organize_folder',
        'Tidy a folder: move its loose files into subfolders by type (Images, Videos, Music, ' +
          'Documents, Spreadsheets, Presentations, Archives, Programs, Code, Other). Nothing is ' +
          'deleted or overwritten; undo_organize puts everything back. dry_run: true shows the plan.',
        { path: z.string().describe('Full path, e.g. C:\\Users\\HP\\Downloads'), dry_run: z.boolean().optional() },
        async ({ path, dry_run }) => {
          const dir = path.replace(/^~(?=[\\/]|$)/, HOME)
          if (!existsSync(dir) || !statSync(dir).isDirectory()) return failText(`No folder at ${path}.`)
          const low = dir.toLowerCase()
          if (/^[a-z]:\\?$/i.test(dir) || low === HOME.toLowerCase() || /\\(windows|program files|appdata)/i.test(low)) {
            return failText('Refused: not a drive root, the user folder or a system folder.')
          }
          const files = readdirSync(dir).filter((f) => {
            if (f.startsWith('.') || f.endsWith('.lnk') || f.endsWith('.tmp') || f.endsWith('.crdownload')) return false
            try {
              return statSync(join(dir, f)).isFile()
            } catch {
              return false
            }
          })
          if (!files.length) return text('No loose files to sort.')
          const plan = {}
          for (const f of files) (plan[typeOf(f)] ??= []).push(f)
          const summary = Object.entries(plan).map(([k, v]) => `${k}: ${v.length}`).join(', ')
          if (dry_run) return text(`Would sort ${files.length} files — ${summary}.`)
          const moved = []
          for (const [kind, list] of Object.entries(plan)) {
            mkdirSync(join(dir, kind), { recursive: true })
            for (const f of list) {
              let target = join(dir, kind, f)
              for (let i = 2; existsSync(target); i++) target = join(dir, kind, `${basename(f, extname(f))} (${i})${extname(f)}`)
              try {
                renameSync(join(dir, f), target)
                moved.push({ from: join(dir, f), to: target })
              } catch {
                /* in use: left where it is */
              }
            }
          }
          writeFileSync(undoFile(dir), JSON.stringify({ at: Date.now(), moved }, null, 1))
          return text(`Sorted ${moved.length} of ${files.length} files — ${summary}. "Undo that" puts them back.`)
        },
      ),
      tool(
        'undo_organize',
        'Put back the files organize_folder last moved in a folder.',
        { path: z.string() },
        async ({ path }) => {
          const dir = path.replace(/^~(?=[\\/]|$)/, HOME)
          let log
          try {
            log = JSON.parse(readFileSync(undoFile(dir), 'utf8'))
          } catch {
            return failText('Nothing to undo in that folder.')
          }
          let back = 0
          for (const m of log.moved) {
            if (existsSync(m.to) && !existsSync(m.from)) {
              try {
                renameSync(m.to, m.from)
                back++
              } catch {
                /* skip */
              }
            }
          }
          for (const k of [...Object.keys(TYPES), 'Other']) {
            try {
              if (readdirSync(join(dir, k)).length === 0) rmSync(join(dir, k), { recursive: true })
            } catch {
              /* not there */
            }
          }
          rmSync(undoFile(dir), { force: true })
          return text(`Put back ${back} files.`)
        },
      ),
      tool(
        'add_routine',
        'A request JARVIS carries out by himself every day (or on chosen days) at a time, while he ' +
          'is running: "every morning at 8 brief me on the news", "weekdays at 6 pm remind me what is ' +
          'on tomorrow". request is what he will be asked, in words.',
        {
          time: z.string().describe('24-hour HH:MM, e.g. "08:00"'),
          request: z.string(),
          days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).optional().describe('Default every day'),
        },
        async ({ time, request, days }) => {
          const m = String(time).match(/^(\d{1,2}):(\d{2})$/)
          if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return failText('Give the time as HH:MM, 24-hour.')
          const r = { id: randomUUID().slice(0, 8), time: `${m[1].padStart(2, '0')}:${m[2]}`, request: request.trim(), days: days ?? [] }
          writeRoutines([...readRoutines(), r])
          return text(`Routine set: ${r.days.length ? r.days.join(', ') : 'every day'} at ${r.time} — "${r.request}".`)
        },
      ),
      tool('list_routines', 'The routines JARVIS carries out by himself.', {}, async () => {
        const list = readRoutines()
        if (!list.length) return text('No routines set.')
        return text(list.map((r) => `• [${r.id}] ${r.days?.length ? r.days.join(', ') : 'every day'} at ${r.time}: ${r.request}`).join('\n'))
      }),
      tool(
        'remove_routine',
        'Stop a routine, by its id from list_routines (or words from its request).',
        { id: z.string() },
        async ({ id }) => {
          const list = readRoutines()
          const keep = list.filter((r) => r.id !== id && !r.request.toLowerCase().includes(id.toLowerCase()))
          if (keep.length === list.length) return failText('No routine matches that.')
          writeRoutines(keep)
          return text(`Removed ${list.length - keep.length} routine(s).`)
        },
      ),
    ],
  })
}

export const PROMPT_EXTRAS = `Everyday extras — the jarvis_extras tools:
- "Read this bill / screenshot / what's written here": read_text_in_image
  (screen: true only when they ask to read the screen).
- QR codes (links, Wi-Fi, phone): make_qr_code. "Summarise this YouTube video":
  youtube_transcript, then summarise. Distances and driving time:
  route_distance. Money: convert_currency. Word meanings: define_word.
- "Tidy my Downloads": organize_folder (dry_run first if they seem unsure);
  "undo that": undo_organize.
- "Every morning at 8 brief me …", "weekdays at 6 remind me …": add_routine
  (it runs while JARVIS is on); list_routines, remove_routine.

`
