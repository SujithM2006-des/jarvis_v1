import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Making documents: a PDF (an abstract of what is on screen, notes, a report)
 * or a plain text / Markdown file. The PDF is rendered by headless Chrome or
 * Edge from a small HTML page, so headings, lists and bold come out properly
 * typeset with no extra dependency. Edge ships with Windows, so one of the two
 * is always there.
 */

/** Tools here that create files; withheld without write access. */
export const DOCUMENT_WRITE_TOOLS = ['make_pdf', 'save_document']

const BROWSERS = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
]

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inline Markdown: **bold**, *italic*, `code`. Input is already escaped. */
const inline = (s) =>
  s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')

/** Just enough Markdown for what he writes: headings, lists, paragraphs, quotes, rules. */
export function markdownToHtml(md) {
  const out = []
  let list = null // 'ul' | 'ol'
  let para = []
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(esc(para.join(' ')))}</p>`)
    para = []
  }
  const closeList = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (const raw of String(md).replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd()
    let m
    if (!line.trim()) {
      flushPara()
      closeList()
    } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara()
      closeList()
      const n = Math.min(Math.max(m[1].length, 2), 4) // the title is the document's only h1
      out.push(`<h${n}>${inline(esc(m[2]))}</h${n}>`)
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara()
      closeList()
      out.push('<hr>')
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara()
      const kind = /^\s*\d/.test(line) ? 'ol' : 'ul'
      if (list !== kind) {
        closeList()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline(esc(m[1]))}</li>`)
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara()
      closeList()
      out.push(`<blockquote>${inline(esc(m[1]))}</blockquote>`)
    } else {
      closeList()
      para.push(line.trim())
    }
  }
  flushPara()
  closeList()
  return out.join('\n')
}

function page(title, bodyHtml) {
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { size: A4; margin: 22mm 20mm; }
body { font-family: "Segoe UI", Calibri, Arial, sans-serif; font-size: 11.5pt; line-height: 1.55; color: #1b1f24; }
header { border-bottom: 2px solid #0f9d96; padding-bottom: 8px; margin-bottom: 18px; }
h1 { font-size: 22pt; margin: 0 0 4px; color: #0b3d3a; }
.date { color: #5b6670; font-size: 10pt; }
h2 { font-size: 15pt; color: #0b3d3a; margin: 20px 0 6px; }
h3 { font-size: 12.5pt; margin: 16px 0 4px; }
h4 { font-size: 11.5pt; margin: 12px 0 4px; }
p { margin: 0 0 10px; text-align: justify; }
ul, ol { margin: 0 0 10px 0; padding-left: 22px; }
li { margin: 2px 0; }
blockquote { margin: 8px 0; padding: 6px 12px; border-left: 3px solid #0f9d96; color: #3c4650; background: #f3f8f8; }
code { font-family: Consolas, monospace; background: #f1f3f5; padding: 0 3px; border-radius: 3px; }
hr { border: 0; border-top: 1px solid #d5dbe0; margin: 14px 0; }
</style></head><body><header><h1>${esc(title)}</h1><div class="date">${date}</div></header>
${bodyHtml}
</body></html>`
}

/** A file name that is safe and not already taken: "Report.pdf", "Report (2).pdf", … */
async function freeName(folder, name, ext) {
  const stem = (name || 'Document')
    .replace(new RegExp(`\\${ext}$`, 'i'), '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Document'
  for (let i = 1; i < 500; i++) {
    const file = join(folder, i === 1 ? `${stem}${ext}` : `${stem} (${i})${ext}`)
    if (!existsSync(file)) return file
  }
  throw new Error('Could not find a free file name.')
}

function run(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err) => (err ? reject(err) : resolve()))
  })
}

/**
 * @param {{ ps: Function, resolveUserPath: Function, protectedProblem: Function, ok: Function, fail: Function }} deps
 */
export function documentTools({ ps, resolveUserPath, protectedProblem, ok, fail }) {
  /** The folder to save into: what they named, else Documents\Jarvis. */
  const target = async (folder) => {
    const dir = await resolveUserPath(folder?.trim() ? folder : 'documents\\Jarvis')
    const bad = protectedProblem(dir, { forWrite: true })
    if (bad) throw new Error(`Refused: ${bad}.`)
    await mkdir(dir, { recursive: true })
    return dir
  }
  const reveal = (file) => ps('Invoke-Item -LiteralPath $env:JARVIS_F', { F: file }).catch(() => {})

  const folderArg = z
    .string()
    .optional()
    .describe('Where to save: a folder name like "desktop", "downloads", "documents\\College", or a full path. Default Documents\\Jarvis.')

  return [
    tool(
      'make_pdf',
      'Create a PDF document and save it. Use for "make a PDF of this", "create an abstract ' +
        'and save it as PDF", "put these notes in a PDF", "make a report on …". Write the ' +
        'content yourself in Markdown — "## Heading", "- bullet", "1. step", **bold**, ' +
        'paragraphs separated by blank lines — not HTML. Do not repeat the title inside the ' +
        'content; it is printed at the top with the date. To make one from what is on their ' +
        'screen, call screen_capture first and write from what you actually see. Opens the PDF ' +
        'when done unless open is false.',
      {
        title: z.string().describe('Document title, e.g. "Abstract: Photosynthesis".'),
        content: z.string().describe('The body, in Markdown.'),
        filename: z.string().optional().describe('File name without folder; default is the title.'),
        folder: folderArg,
        open: z.boolean().optional(),
      },
      async ({ title, content, filename, folder, open }) => {
        const browser = BROWSERS.find((b) => existsSync(b))
        if (!browser) return fail('Neither Chrome nor Edge is installed, so I cannot make a PDF.')
        const work = join(tmpdir(), `jarvis-pdf-${Date.now()}`)
        try {
          const dir = await target(folder)
          const file = await freeName(dir, filename || title, '.pdf')
          await mkdir(work, { recursive: true })
          const html = join(work, 'doc.html')
          await writeFile(html, page(title, markdownToHtml(content)), 'utf8')
          await run(
            browser,
            [
              '--headless=new',
              '--disable-gpu',
              '--no-first-run',
              '--no-default-browser-check',
              `--user-data-dir=${join(work, 'profile')}`,
              '--no-pdf-header-footer',
              '--print-to-pdf-no-header',
              `--print-to-pdf=${file}`,
              pathToFileURL(html).href,
            ],
            90_000,
          )
          const size = (await stat(file)).size
          if (!size) throw new Error('the PDF came out empty')
          if (open !== false) await reveal(file)
          return ok(`Saved ${basename(file)} in ${dir}${open !== false ? ' and opened it' : ''}. Full path: ${file}`)
        } catch (err) {
          return fail(`Could not make the PDF: ${err.message}`)
        } finally {
          rm(work, { recursive: true, force: true }).catch(() => {})
        }
      },
    ),
    tool(
      'save_document',
      'Save text you have written as a file: "save that as a text file", "write these notes ' +
        'to a file on my desktop". format txt (default) or md. For a PDF use make_pdf. Opens ' +
        'it when done unless open is false.',
      {
        filename: z.string().describe('File name, e.g. "Meeting notes".'),
        content: z.string(),
        format: z.enum(['txt', 'md']).optional(),
        folder: folderArg,
        open: z.boolean().optional(),
      },
      async ({ filename, content, format, folder, open }) => {
        try {
          const ext = `.${format ?? (extname(filename).toLowerCase() === '.md' ? 'md' : 'txt')}`
          const dir = await target(folder)
          const file = await freeName(dir, filename.replace(/\.(txt|md)$/i, ''), ext)
          // A BOM so Notepad and older editors read accents and symbols correctly.
          await writeFile(file, '\uFEFF' + String(content).replace(/\r?\n/g, '\r\n'), 'utf8')
          if (open !== false) await reveal(file)
          return ok(`Saved ${basename(file)} in ${dir}${open !== false ? ' and opened it' : ''}. Full path: ${file}`)
        } catch (err) {
          return fail(`Could not save it: ${err.message}`)
        }
      },
    ),
  ]
}
