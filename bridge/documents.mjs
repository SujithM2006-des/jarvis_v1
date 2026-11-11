import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Making documents: a PDF (an abstract of what is on screen, notes, a report)
 * or a plain text / Markdown file. The PDF is rendered by headless Chrome or
 * Edge from a small HTML page, so headings, lists and bold come out properly
 * typeset with no extra dependency. Edge ships with Windows, so one of the two
 * is always there.
 */

/** Tools here that create or change files; withheld without write access. */
export const DOCUMENT_WRITE_TOOLS = ['make_pdf', 'save_document', 'edit_document', 'undo_document_edit']

// Reading and editing the user's own documents. Office files go through
// scripts/doc_tool.py (python-docx, openpyxl, python-pptx in the wake
// listener's Python — no Office needed); text and code are handled here.
// Every edit is backed up first, so it can always be undone.
const DOC_TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'doc_tool.py')
const PYTHON = join(homedir(), '.jarvis', 'wake-venv', 'Scripts', 'python.exe')
const BACKUPS = join(homedir(), '.jarvis', 'doc-backups')
const BACKUP_INDEX = join(BACKUPS, 'index.json')
const OFFICE = new Set(['.docx', '.xlsx', '.xlsm', '.pptx'])
const TEXTISH = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx',
  '.py', '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.php', '.rb', '.sql', '.yml', '.yaml', '.ini', '.log',
  '.bat', '.ps1', '.sh', '.kt', '.swift', '.dart', '.vue',
])

function runDocTool(args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    if (!existsSync(PYTHON)) return reject(new Error('the document engine (~/.jarvis/wake-venv) is not installed'))
    execFile(PYTHON, [DOC_TOOL, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n').pop())) : resolve(stdout)))
  })
}

async function readIndex() {
  try {
    return JSON.parse(await readFile(BACKUP_INDEX, 'utf8'))
  } catch {
    return []
  }
}

/** Copy the file aside before changing it; remembered for undo. */
async function backupDoc(file) {
  await mkdir(BACKUPS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const copy = join(BACKUPS, `${stamp}__${basename(file)}`)
  await copyFile(file, copy)
  const index = await readIndex()
  index.push({ original: file, backup: copy, at: Date.now() })
  await writeFile(BACKUP_INDEX, JSON.stringify(index.slice(-300), null, 2))
  return copy
}

const BROWSERS = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
]

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

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
    } else if ((m = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/))) {
      // An image: a local file only (a screenshot, an attached picture),
      // shown as a captioned figure. Anything else is left as plain text.
      flushPara()
      closeList()
      const src = m[2].trim().replace(/^["']|["']$/g, '')
      if (/^[a-z]:[\\/]/i.test(src) && IMAGE_EXT.test(src) && existsSync(src)) {
        const cap = m[1].trim()
        out.push(
          `<figure><img src="${esc(pathToFileURL(src).href)}" alt="${esc(cap)}">` +
            (cap ? `<figcaption>${inline(esc(cap))}</figcaption>` : '') +
            '</figure>',
        )
      } else {
        para.push(line.trim())
      }
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
figure { margin: 12px 0 16px; text-align: center; page-break-inside: avoid; }
figure img { max-width: 100%; max-height: 120mm; border-radius: 6px; border: 1px solid #d5dbe0; }
figcaption { margin-top: 6px; font-size: 9.5pt; color: #5b6670; }
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
        'paragraphs separated by blank lines — not HTML. An image on its own line, ' +
        '![caption](C:\\full\\path\\picture.png), is placed as a figure (a local file: a screenshot ' +
        'you took, an attached picture). Do not repeat the title inside the ' +
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
      'read_document',
      'Open one of the user\'s documents to review, summarise, check or answer questions about it: ' +
        'Word (.docx), Excel (.xlsx), PowerPoint (.pptx), PDF, and text or code files (txt, md, csv, ' +
        'json, py, java, js, html …). Give the full path — find it first with find_files or ' +
        'explorer_selection ("this file"). Word comes back with headings (#), lists and tables; ' +
        'Excel as cell=value per row; PowerPoint slide by slide. A PDF is copied somewhere you can ' +
        'open it with the Read tool.',
      { path: z.string().describe('Full path, or e.g. "documents\\\\report.docx".') },
      async ({ path }) => {
        try {
          const file = await resolveUserPath(path)
          const bad = protectedProblem(file)
          if (bad) return fail(`Refused: ${bad}.`)
          const info = await stat(file)
          if (!info.isFile()) return fail('That is a folder, not a document.')
          if (info.size > 30 * 1024 * 1024) return fail('That file is too large (30 MB limit).')
          const ext = extname(file).toLowerCase()
          if (OFFICE.has(ext)) {
            const text = await runDocTool(['read', file])
            return ok(`${basename(file)}:\n${text.length > 60_000 ? text.slice(0, 60_000) + '\n… (truncated)' : text}`)
          }
          if (ext === '.pdf') {
            const dir = join(tmpdir(), 'jarvis-docs', String(Date.now()))
            await mkdir(dir, { recursive: true })
            const copy = join(dir, basename(file))
            await copyFile(file, copy)
            return ok(`Open the PDF with the Read tool at: ${copy}`)
          }
          if (TEXTISH.has(ext) || !ext) {
            const text = await readFile(file, 'utf8')
            return ok(`${basename(file)}:\n${text.length > 80_000 ? text.slice(0, 80_000) + '\n… (truncated)' : text}`)
          }
          return fail(`${ext} files cannot be read here. Word, Excel, PowerPoint, PDF and text/code files can.`)
        } catch (err) {
          return fail(err.code === 'ENOENT' ? 'That file does not exist — find it with find_files first.' : `Could not read it: ${err.message}`)
        }
      },
    ),
    tool(
      'edit_document',
      'Change one of the user\'s documents as they asked: fix wording, correct names or numbers, add ' +
        'a paragraph or section, remove a line, update spreadsheet cells. ALWAYS read_document first, ' +
        'and use exact text from it in "find". Edits: {op:"replace", find, replace, all?} (Word, ' +
        'PowerPoint, Excel, text); {op:"append", text, style?} (Word, e.g. style "Heading 2"; text ' +
        'files); {op:"delete_paragraph", find} (Word); {op:"set_cell", sheet?, cell, value} (Excel); ' +
        '{op:"rewrite", text} (text/code files: the whole new content). The original is backed up ' +
        'first — undo_document_edit restores it. If the file is open in Word/Excel, ask them to close ' +
        'it. Then say in a sentence what you changed.',
      {
        path: z.string(),
        edits: z
          .array(
            z.object({
              op: z.enum(['replace', 'append', 'delete_paragraph', 'set_cell', 'rewrite']),
              find: z.string().optional(),
              replace: z.string().optional(),
              all: z.boolean().optional(),
              text: z.string().optional(),
              style: z.string().optional(),
              sheet: z.string().optional(),
              cell: z.string().optional(),
              value: z.union([z.string(), z.number()]).optional(),
            }),
          )
          .min(1),
      },
      async ({ path, edits }) => {
        try {
          const file = await resolveUserPath(path)
          const bad = protectedProblem(file, { forWrite: true })
          if (bad) return fail(`Refused: ${bad}.`)
          const ext = extname(file).toLowerCase()
          if (!OFFICE.has(ext) && !TEXTISH.has(ext)) {
            return fail(`${ext || 'That'} cannot be edited here (Word, Excel, PowerPoint and text/code files can).`)
          }
          await stat(file)
          const backup = await backupDoc(file)
          if (OFFICE.has(ext)) {
            const ops = join(tmpdir(), `jarvis-edit-${Date.now()}.json`)
            await writeFile(ops, JSON.stringify(edits))
            try {
              const r = JSON.parse(await runDocTool(['edit', file, ops]))
              return ok(
                `Edited ${basename(file)}: ${r.changes} change(s).` +
                  (r.notes?.length ? ` Notes: ${r.notes.join('; ')}.` : '') +
                  ` Backup kept (undo_document_edit restores it).`,
              )
            } finally {
              rm(ops, { force: true }).catch(() => {})
            }
          }
          // Text and code: done here.
          let text = await readFile(file, 'utf8')
          let changes = 0
          const notes = []
          for (const e of edits) {
            if (e.op === 'rewrite' && typeof e.text === 'string') {
              text = e.text
              changes++
            } else if (e.op === 'replace' && e.find) {
              const n = text.split(e.find).length - 1
              if (!n) notes.push(`not found: "${e.find.slice(0, 60)}"`)
              text = e.all === false ? text.replace(e.find, e.replace ?? '') : text.split(e.find).join(e.replace ?? '')
              changes += e.all === false ? Math.min(n, 1) : n
            } else if (e.op === 'append' && e.text) {
              text = text.replace(/\s*$/, '\n') + e.text + '\n'
              changes++
            } else {
              notes.push(`${e.op}: not supported for text files`)
            }
          }
          await writeFile(file, text, 'utf8')
          return ok(
            `Edited ${basename(file)}: ${changes} change(s).` +
              (notes.length ? ` Notes: ${notes.join('; ')}.` : '') +
              ` Backup kept at ${backup}.`,
          )
        } catch (err) {
          if (err.code === 'ENOENT') return fail('That file does not exist — find it with find_files first.')
          if (err.code === 'EBUSY' || err.code === 'EPERM') return fail('The file is open in another program — ask them to close it first.')
          return fail(`Could not edit it: ${err.message}`)
        }
      },
    ),
    tool(
      'undo_document_edit',
      'Put a document back as it was before your last edit to it ("undo that", "put it back").',
      { path: z.string() },
      async ({ path }) => {
        try {
          const file = await resolveUserPath(path)
          const index = await readIndex()
          const i = index.map((e) => e.original.toLowerCase()).lastIndexOf(file.toLowerCase())
          if (i < 0) return ok(`There is no earlier version of ${basename(file)} to go back to.`)
          await copyFile(index[i].backup, file)
          index.splice(i, 1)
          await writeFile(BACKUP_INDEX, JSON.stringify(index, null, 2))
          return ok(`Restored ${basename(file)} to how it was before the last edit.`)
        } catch (err) {
          if (err.code === 'EBUSY' || err.code === 'EPERM') return fail('The file is open in another program — ask them to close it first.')
          return fail(`Could not restore it: ${err.message}`)
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
