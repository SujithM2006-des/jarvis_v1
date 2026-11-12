/**
 * General skills, for every brain (Claude, Gemini, Groq, OpenRouter, local):
 *
 *   web_search          search the web (DuckDuckGo) — Claude's own WebSearch
 *                       does not work through the other brains
 *   read_webpage        a web page as readable text
 *   run_python          calculations, data analysis, charts, conversions —
 *                       Python with numpy, pandas, matplotlib, openpyxl …
 *   create_presentation a PowerPoint (.pptx) from slides
 *   create_spreadsheet  an Excel workbook (.xlsx) from rows
 *   create_word_document a Word document (.docx) from headings, paragraphs, lists
 *   download_file       a file from the web into Downloads
 *   edit_image          resize, crop to an aspect, convert, compress, rotate
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { fetchText, vetTarget } from './net.mjs'
import { findTool } from './creator.mjs'

export const SKILL_WRITE_TOOLS = new Set([
  'run_python', 'create_presentation', 'create_spreadsheet', 'create_word_document', 'download_file', 'edit_image',
])

const HOME = homedir()
const SCRIPTS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'scripts')
const PY = join(HOME, '.jarvis', 'wake-venv', 'Scripts', 'python.exe')
const OUT = {
  docs: join(HOME, 'Documents', 'Jarvis'),
  pictures: join(HOME, 'Pictures', 'Jarvis'),
  downloads: join(HOME, 'Downloads'),
  work: join(HOME, '.jarvis', 'python-work'),
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const failText = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const safeName = (s, fallback) =>
  (String(s ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback)
const outFile = (dir, name, ext) => {
  mkdirSync(dir, { recursive: true })
  const base = safeName(name, 'jarvis').replace(new RegExp(`${ext.replace('.', '\\.')}$`, 'i'), '')
  let f = join(dir, `${base}${ext}`)
  for (let i = 2; existsSync(f); i++) f = join(dir, `${base} (${i})${ext}`)
  return f
}
const openFile = (f) => spawn('cmd.exe', ['/c', 'start', '""', f], { detached: true, stdio: 'ignore', windowsHide: true }).unref()

function run(file, args, { timeoutMs = 120_000, cwd, env } = {}) {
  return new Promise((res, rej) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, cwd, env }, (err, stdout, stderr) => {
      if (err) {
        const why = err.killed ? `stopped after ${timeoutMs / 1000} s` : String(stderr || err.message).trim().split('\n').slice(-6).join('\n')
        return rej(Object.assign(new Error(why), { stdout: String(stdout ?? '') }))
      }
      res({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

// ---------------------------------------------------------------- the web

const decode = (s) =>
  String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export async function webSearch(query, count = 6) {
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' },
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error(`search answered ${r.status}`)
  const html = await r.text()
  const out = []
  for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<\/div>)/g)) {
    let url = m[1].replace(/&amp;/g, '&')
    const u = url.match(/[?&]uddg=([^&]+)/)
    if (u) url = decodeURIComponent(u[1])
    if (url.startsWith('//')) url = `https:${url}`
    if (/duckduckgo\.com\/y\.js/.test(url)) continue // ads
    out.push({ title: decode(m[2]), url, snippet: decode(m[3] ?? '') })
    if (out.length >= count) break
  }
  return out
}

/** A page's readable text: scripts, styles and markup gone, headings kept as lines. */
export async function pageText(url, maxChars = 12000) {
  const page = await fetchText(url, { maxBytes: 4 * 1024 * 1024, timeoutMs: 20000 })
  if (!/html|xml|text\/plain/.test(page.type)) throw new Error(`not a web page (${page.type || 'unknown type'})`)
  let h = page.text
  const title = decode((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? '')
  h = h
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
  const body = h
    .split('\n')
    .map(decode)
    .filter((l) => l.length > 2)
    .join('\n')
  return { title, url: page.url, text: body.slice(0, maxChars), truncated: body.length > maxChars }
}

// ---------------------------------------------------------------- python

/** Code that deletes or overwrites things: run only with the user's yes. */
const RISKY_PY =
  /\b(os\.(remove|unlink|rmdir|removedirs|system|popen)|shutil\.(rmtree|move)|send2trash|subprocess|Path\([^)]*\)\.(unlink|rmdir)|\.unlink\(|\.rmdir\(|format\s+[a-z]:|winreg|ctypes)/i

async function runPython(code, timeoutSec = 120) {
  if (!existsSync(PY)) throw new Error("JARVIS's Python is not installed (the wake listener's environment).")
  mkdirSync(OUT.work, { recursive: true })
  const file = join(OUT.work, `run-${stamp()}.py`)
  // Charts: matplotlib without a window; savefig paths are relative to the work folder.
  const prelude =
    'import os, sys\nos.environ.setdefault("MPLBACKEND", "Agg")\nsys.stdout.reconfigure(encoding="utf-8")\n' +
    `PICTURES = r"${OUT.pictures}"\nDOCUMENTS = r"${OUT.docs}"\nos.makedirs(PICTURES, exist_ok=True); os.makedirs(DOCUMENTS, exist_ok=True)\n`
  writeFileSync(file, prelude + code)
  try {
    const r = await run(PY, ['-I', file], { timeoutMs: Math.min(600, Math.max(5, timeoutSec)) * 1000, cwd: OUT.work })
    return { out: (r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).trim() }
  } finally {
    rmSync(file, { force: true })
  }
}

// ---------------------------------------------------------------- office files

async function office(spec) {
  const f = join(tmpdir(), `jarvis-office-${stamp()}.json`)
  writeFileSync(f, JSON.stringify(spec))
  try {
    await run(PY, ['-I', join(SCRIPTS, 'office_create.py'), f], { timeoutMs: 90_000 })
    return spec.path
  } finally {
    rmSync(f, { force: true })
  }
}

// ---------------------------------------------------------------- the tools

export function skillsServer() {
  return createSdkMcpServer({
    name: 'jarvis_skills',
    version: '1.0.0',
    instructions: 'Web search and pages, Python, Office files, downloads and image edits.',
    alwaysLoad: true,
    tools: [
      tool(
        'web_search',
        'Search the web: titles, links and snippets of the top results. Use for anything current or ' +
          'factual you are not sure of, then read_webpage for detail. Never invent what a page says.',
        { query: z.string(), count: z.number().optional().describe('Results, default 6, at most 10') },
        async ({ query, count = 6 }) => {
          try {
            const hits = await webSearch(query, Math.min(10, Math.max(1, count)))
            if (!hits.length) return text(`No results for "${query}".`)
            return text(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n'))
          } catch (err) {
            return failText(`Search failed: ${err.message}`)
          }
        },
      ),
      tool(
        'read_webpage',
        'Read a web page as plain text (title, then the text), to answer from it or summarise it.',
        { url: z.string(), max_chars: z.number().optional().describe('Default 12000') },
        async ({ url, max_chars = 12000 }) => {
          try {
            vetTarget(url)
            const p = await pageText(url, Math.min(40000, Math.max(1000, max_chars)))
            return text(`${p.title}\n${p.url}\n\n${p.text}${p.truncated ? '\n…(truncated)' : ''}`)
          } catch (err) {
            return failText(`Could not read the page: ${err.message}`)
          }
        },
      ),
      tool(
        'run_python',
        'Run Python 3 to calculate, analyse data, convert files or draw charts. numpy, pandas, ' +
          'matplotlib, openpyxl, python-docx, python-pptx and Pillow are installed. print() the answer. ' +
          'Save charts with plt.savefig(os.path.join(PICTURES, "name.png")) — PICTURES and DOCUMENTS are ' +
          'predefined folders. Code that deletes, moves or runs programs needs confirmed: true, set only ' +
          'after the user said yes to exactly that.',
        {
          code: z.string(),
          purpose: z.string().describe('One line: what this code does, in plain words'),
          confirmed: z.boolean().optional(),
          timeout_seconds: z.number().optional().describe('Default 120, at most 600'),
        },
        async ({ code, purpose, confirmed, timeout_seconds = 120 }) => {
          if (RISKY_PY.test(code) && confirmed !== true) {
            return failText(
              `Not run: this code can delete, move or run things (${purpose}). Ask the user to confirm ` +
                'in one sentence, and only if they say yes, call again with confirmed: true.',
            )
          }
          try {
            const r = await runPython(code, timeout_seconds)
            console.log(`[jarvis] python ok: ${purpose}`)
            return text(r.out ? r.out.slice(0, 20000) : '(no output — print() the result)')
          } catch (err) {
            return failText(`Python error:\n${err.message}`.slice(0, 4000))
          }
        },
      ),
      tool(
        'create_presentation',
        'Make a PowerPoint presentation (.pptx, 16:9) in Documents\\Jarvis and open it: a title slide, ' +
          'then one slide per item with a title and 3-6 short bullets (optional speaker notes).',
        {
          name: z.string(),
          title: z.string(),
          subtitle: z.string().optional(),
          slides: z.array(z.object({ title: z.string(), bullets: z.array(z.string()), notes: z.string().optional() })).min(1).max(40),
        },
        async ({ name, title, subtitle = '', slides }) => {
          try {
            const f = await office({ kind: 'pptx', path: outFile(OUT.docs, name, '.pptx'), title, subtitle, slides })
            openFile(f)
            return text(`Presentation saved with ${slides.length + 1} slides: ${f}`)
          } catch (err) {
            return failText(`Could not make the presentation: ${err.message}`)
          }
        },
      ),
      tool(
        'create_spreadsheet',
        'Make an Excel workbook (.xlsx) in Documents\\Jarvis and open it. Each sheet is rows of values; ' +
          'the first row is the header (styled, frozen). Numbers as numbers, not text. Formulas as ' +
          'strings starting with "=" work.',
        {
          name: z.string(),
          sheets: z.array(z.object({ name: z.string(), rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))) })).min(1),
        },
        async ({ name, sheets }) => {
          try {
            const f = await office({ kind: 'xlsx', path: outFile(OUT.docs, name, '.xlsx'), sheets })
            openFile(f)
            return text(`Spreadsheet saved (${sheets.map((s) => `${s.name}: ${s.rows.length} rows`).join(', ')}): ${f}`)
          } catch (err) {
            return failText(`Could not make the spreadsheet: ${err.message}`)
          }
        },
      ),
      tool(
        'create_word_document',
        'Make a Word document (.docx) in Documents\\Jarvis and open it: a title, then blocks — ' +
          'heading {text, level 1-3}, paragraph {text}, bullets {items}, numbered {items}. For letters, ' +
          'reports, essays, resumes, notes.',
        {
          name: z.string(),
          title: z.string().optional(),
          blocks: z.array(
            z.object({
              type: z.enum(['heading', 'paragraph', 'bullets', 'numbered']),
              text: z.string().optional(),
              level: z.number().optional(),
              items: z.array(z.string()).optional(),
            }),
          ),
        },
        async ({ name, title, blocks }) => {
          try {
            const f = await office({ kind: 'docx', path: outFile(OUT.docs, name, '.docx'), title, blocks })
            openFile(f)
            return text(`Word document saved: ${f}`)
          } catch (err) {
            return failText(`Could not make the document: ${err.message}`)
          }
        },
      ),
      tool(
        'download_file',
        'Download a file from a web address into Downloads (or a name given). Up to 2 GB. Refuses ' +
          'local-network addresses. Say what it is before downloading programs.',
        { url: z.string(), name: z.string().optional() },
        async ({ url, name }) => {
          try {
            vetTarget(url)
            const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) })
            if (!r.ok || !r.body) throw new Error(`the server answered ${r.status}`)
            const size = Number(r.headers.get('content-length') ?? 0)
            if (size > 2 * 1024 ** 3) throw new Error('the file is larger than 2 GB')
            const fromUrl = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'download')
            const want = name || fromUrl
            const ext = extname(want) || extname(fromUrl) || ''
            const f = outFile(OUT.downloads, basename(want, extname(want)), ext)
            await pipeline(Readable.fromWeb(r.body), createWriteStream(f))
            const mb = (statSync(f).size / 1048576).toFixed(1)
            return text(`Downloaded ${basename(f)} (${mb} MB) to Downloads.`)
          } catch (err) {
            return failText(`Download failed: ${err.message}`)
          }
        },
      ),
      tool(
        'edit_image',
        'Edit an image (saved as a new file next to Pictures\\Jarvis; the original kept): ' +
          'resize {width}, crop {aspect "1:1"|"9:16"|"16:9"|"4:5"}, rotate {degrees 90|180|270}, ' +
          'convert {format "png"|"jpg"|"webp"}, compress {quality 1-100, jpg/webp}. Steps run in order.',
        {
          input: z.string().describe('The image file (full path)'),
          steps: z.array(z.object({ op: z.enum(['resize', 'crop', 'rotate', 'convert', 'compress']) }).passthrough()),
          name: z.string().optional(),
        },
        async ({ input, steps, name }) => {
          const ff = findTool('ffmpeg')
          if (!ff) return failText('ffmpeg is not installed, so images cannot be edited.')
          if (!existsSync(input)) return failText(`No image at ${input}.`)
          const filters = []
          let format = extname(input).slice(1).toLowerCase().replace('jpeg', 'jpg') || 'png'
          let quality = null
          for (const s of steps) {
            if (s.op === 'resize') filters.push(`scale=${Math.max(16, Math.round(Number(s.width) || 1080))}:-2`)
            else if (s.op === 'crop') {
              const [a, b] = String(s.aspect ?? '1:1').split(':').map(Number)
              filters.push(`crop='min(iw,ih*${a}/${b})':'min(ih,iw*${b}/${a})'`)
            } else if (s.op === 'rotate') {
              const d = Number(s.degrees)
              filters.push(d === 90 ? 'transpose=1' : d === 270 ? 'transpose=2' : d === 180 ? 'transpose=1,transpose=1' : 'null')
            } else if (s.op === 'convert') format = String(s.format ?? 'png').toLowerCase().replace('jpeg', 'jpg')
            else if (s.op === 'compress') quality = Math.min(100, Math.max(1, Number(s.quality) || 75))
          }
          const out = outFile(OUT.pictures, name ?? `${basename(input, extname(input))} edited`, `.${format}`)
          const q = quality == null ? [] : format === 'jpg' ? ['-q:v', String(Math.round(2 + (100 - quality) * 0.29))] : format === 'webp' ? ['-quality', String(quality)] : []
          try {
            await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, ...(filters.length ? ['-vf', filters.join(',')] : []), ...q, '-frames:v', '1', out])
            const kb = (statSync(out).size / 1024).toFixed(0)
            openFile(out)
            return text(`Image saved (${kb} KB): ${out} — the original is unchanged.`)
          } catch (err) {
            return failText(`Could not edit the image: ${err.message}`)
          }
        },
      ),
    ],
  })
}

export const PROMPT_SKILLS = `More skills — the jarvis_skills tools, working with any brain:
- Anything current or factual you are unsure of: web_search, then read_webpage
  for the detail. Say where it came from; never invent what a page says.
- Maths, data, conversions, charts, "analyse this spreadsheet": run_python
  (print the answer; save charts to PICTURES).
- "Make a presentation / spreadsheet / Word document about …": write the content
  yourself, then create_presentation, create_spreadsheet or create_word_document.
- "Download …": download_file. "Resize / crop / convert this picture": edit_image.

`
