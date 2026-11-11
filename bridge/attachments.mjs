import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import { protectedProblem, ps } from './pc.mjs'

/**
 * Files handed to the onscreen popup (📎, drag and drop, paste) for him to
 * work with — "summarise this PDF", "what's in this photo", "fix this code".
 *
 * Each file is copied into the temp folder, which his file tools are allowed to
 * read (policy.mjs: workspace + temp only), so the user's own folders stay
 * closed to them. There, the Read tool shows images and PDFs as they are and
 * reads text and code. Word, Excel and PowerPoint it cannot open, so those are
 * turned into a .txt beside the copy. The copies are cleared after a day.
 */

const ROOT = join(tmpdir(), 'jarvis-attach')
const MAX_FILES = 10
const MAX_BYTES = 30 * 1024 * 1024
const KEEP_MS = 24 * 60 * 60 * 1000

const OFFICE = new Set(['.docx', '.pptx', '.xlsx'])
/** Images the model reads directly; the rest are converted to PNG first. */
const IMAGE_OK = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const IMAGE_CONVERT = new Set(['.bmp', '.tif', '.tiff', '.ico'])
const OLD_OFFICE = new Set(['.doc', '.ppt', '.xls'])
const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.webm', '.flac'])

// Office Open XML is a zip of XML parts: read the text out of the parts that
// hold it. Paths arrive through env vars (see ps() in pc.mjs), never the script.
const EXTRACT = String.raw`
Add-Type -AssemblyName System.IO.Compression.FileSystem
$NL = [string][char]10; $TAB = [string][char]9
$z = [IO.Compression.ZipFile]::OpenRead($env:JARVIS_SRC)
function Read-Part($e) { $r = New-Object IO.StreamReader($e.Open()); $t = $r.ReadToEnd(); $r.Close(); $t }
function Num($e) { [int]([regex]::Match($e.FullName, '(\d+)\.xml$').Groups[1].Value) }
function Plain($x) { [Net.WebUtility]::HtmlDecode(($x -replace '<[^>]+>', '')) }
$out = New-Object Text.StringBuilder
try {
  switch ($env:JARVIS_EXT) {
    '.docx' {
      $x = Read-Part ($z.GetEntry('word/document.xml'))
      # Tables first: a cell's last paragraph ends the cell (tab), a row ends
      # the line — so a table reads as rows and columns, not run-on text.
      $x = $x -replace '</w:p>\s*</w:tc>', $TAB -replace '</w:tr>', $NL
      $x = $x -replace '</w:p>', $NL -replace '<w:tab/>', $TAB -replace '<w:br/>', $NL
      [void]$out.Append((Plain $x))
    }
    '.pptx' {
      $slides = $z.Entries | Where-Object { $_.FullName -match '^ppt/slides/slide\d+\.xml$' } | Sort-Object { Num $_ }
      $i = 0
      foreach ($s in $slides) {
        $i++
        $x = (Read-Part $s) -replace '</a:p>', $NL
        [void]$out.Append("--- Slide $i ---" + $NL + (Plain $x) + $NL)
      }
    }
    '.xlsx' {
      $ss = @()
      $e = $z.GetEntry('xl/sharedStrings.xml')
      if ($e) { $ss = @([regex]::Matches((Read-Part $e), '<si>(.*?)</si>', 'Singleline') | ForEach-Object { Plain $_.Groups[1].Value }) }
      $sheets = $z.Entries | Where-Object { $_.FullName -match '^xl/worksheets/sheet\d+\.xml$' } | Sort-Object { Num $_ }
      foreach ($sh in $sheets) {
        [void]$out.Append("--- Sheet $(Num $sh) ---" + $NL)
        foreach ($row in [regex]::Matches((Read-Part $sh), '<row[^>]*>(.*?)</row>', 'Singleline')) {
          $vals = foreach ($c in [regex]::Matches($row.Groups[1].Value, '<c([^>]*?)(?:/>|>(.*?)</c>)', 'Singleline')) {
            $attr = $c.Groups[1].Value; $inner = $c.Groups[2].Value
            $v = [regex]::Match($inner, '<v>(.*?)</v>').Groups[1].Value
            if ($attr -match 't="s"' -and $v -ne '') { $ss[[int]$v] }
            elseif ($attr -match 't="inlineStr"') { Plain $inner }
            else { [Net.WebUtility]::HtmlDecode($v) }
          }
          [void]$out.Append((($vals | ForEach-Object { "$_" }) -join $TAB) + $NL)
        }
      }
    }
  }
} finally { $z.Dispose() }
[IO.File]::WriteAllText($env:JARVIS_OUT, $out.ToString(), (New-Object Text.UTF8Encoding $false))
`

// Old binary Office formats, converted with Office itself (read-only, hidden):
// .doc → .docx, .xls → .xlsx, .ppt → .pptx, then read like the new ones.
const UPGRADE = String.raw`
$src = $env:JARVIS_SRC; $out = $env:JARVIS_OUT
switch ($env:JARVIS_EXT) {
  '.doc' {
    $app = New-Object -ComObject Word.Application; $app.Visible = $false; $app.DisplayAlerts = 0
    try { $d = $app.Documents.Open($src, $false, $true); $d.SaveAs2($out, 16); $d.Close($false) } finally { $app.Quit() }
  }
  '.xls' {
    $app = New-Object -ComObject Excel.Application; $app.Visible = $false; $app.DisplayAlerts = $false
    try { $w = $app.Workbooks.Open($src, 0, $true); $w.SaveAs($out, 51); $w.Close($false) } finally { $app.Quit() }
  }
  '.ppt' {
    $app = New-Object -ComObject PowerPoint.Application
    try { $p = $app.Presentations.Open($src, -1, 0, 0); $p.SaveAs($out, 24); $p.Close() } finally { $app.Quit() }
  }
}
if (-not (Test-Path -LiteralPath $out)) { throw 'conversion produced nothing' }
`

const CONVERT = String.raw`
Add-Type -AssemblyName System.Drawing
$img = [Drawing.Image]::FromFile($env:JARVIS_SRC)
try { $img.Save($env:JARVIS_OUT, [Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }
`

/** Remove copies older than a day. Never throws. */
async function sweep() {
  try {
    const now = Date.now()
    for (const d of await readdir(ROOT)) {
      const p = join(ROOT, d)
      const s = await stat(p).catch(() => null)
      if (s && now - s.mtimeMs > KEEP_MS) await rm(p, { recursive: true, force: true }).catch(() => {})
    }
  } catch {
    /* nothing there yet */
  }
}

/**
 * Copy the files somewhere he can read them and describe each.
 * @param {string[]} paths absolute paths from the popup
 * @returns {Promise<{ items: { name: string, path: string, note: string }[], problems: string[] }>}
 */
export async function prepareAttachments(paths) {
  void sweep()
  const items = []
  const problems = []
  const list = (Array.isArray(paths) ? paths : []).map((p) => String(p ?? '').trim()).filter(Boolean)
  if (list.length > MAX_FILES) problems.push(`more than ${MAX_FILES} files: only the first ${MAX_FILES} were attached`)
  const dir = join(ROOT, String(Date.now()))
  await mkdir(dir, { recursive: true })

  for (const src of list.slice(0, MAX_FILES)) {
    const name = basename(src)
    try {
      if (!isAbsolute(src)) throw new Error('not a full path')
      const bad = protectedProblem(src)
      if (bad) throw new Error(bad)
      const info = await stat(src)
      if (!info.isFile()) throw new Error('it is a folder, not a file')
      if (info.size > MAX_BYTES) throw new Error('it is larger than 30 MB')

      const ext = extname(name).toLowerCase()
      // A numbered sub-folder per file, so two files with the same name coexist.
      const sub = join(dir, String(items.length + 1))
      await mkdir(sub, { recursive: true })
      const copy = join(sub, name)
      await copyFile(src, copy)

      if (OFFICE.has(ext)) {
        const txt = `${copy}.txt`
        await ps(EXTRACT, { SRC: copy, OUT: txt, EXT: ext }, 60_000)
        items.push({ name, path: txt, note: `the text of ${name}, extracted` })
      } else if (IMAGE_CONVERT.has(ext)) {
        const png = `${copy}.png`
        await ps(CONVERT, { SRC: copy, OUT: png }, 30_000)
        items.push({ name, path: png, note: 'image' })
      } else if (IMAGE_OK.has(ext)) {
        items.push({ name, path: copy, note: 'image' })
      } else if (ext === '.pdf') {
        items.push({ name, path: copy, note: 'PDF' })
      } else if (AUDIO.has(ext)) {
        items.push({
          name,
          path: copy,
          note:
            'audio recording — not readable with Read: use transcribe_audio on it for what is said, ' +
            'or voice_analyze if they asked to change your voice',
        })
      } else if (OLD_OFFICE.has(ext)) {
        // Upgrade with Office, then extract like a modern file. Without
        // Office (or if it fails), say so plainly.
        const modern = `${copy}x`
        const since = new Date().toISOString()
        try {
          // Office automation can hang on a dialog it cannot show (activation,
          // first run) — measured on this PC: Word never returned. Kept short.
          await ps(UPGRADE, { SRC: copy, OUT: modern, EXT: ext }, 40_000)
          const txt = `${modern}.txt`
          await ps(EXTRACT, { SRC: modern, OUT: txt, EXT: `${ext}x` }, 60_000)
          items.push({ name, path: txt, note: `the text of ${name}, extracted` })
        } catch {
          // A stuck conversion leaves a hidden Office process behind; close
          // the window-less ones this attempt started (never the user's own).
          await ps(
            "Get-Process WINWORD, EXCEL, POWERPNT -ErrorAction SilentlyContinue | " +
              'Where-Object { -not $_.MainWindowTitle -and $_.StartTime -ge [datetime]$env:JARVIS_SINCE } | ' +
              'Stop-Process -Force -ErrorAction SilentlyContinue',
            { SINCE: since },
            15_000,
          ).catch(() => {})
          items.push({
            name,
            path: copy,
            note:
              `old ${ext} format that Microsoft Office could not convert here (it may be waiting on an ` +
              `activation or first-run prompt) — ask them to save it as ${ext}x or PDF`,
          })
        }
      } else {
        items.push({ name, path: copy, note: 'file' })
      }
    } catch (err) {
      problems.push(`${name}: ${err.code === 'ENOENT' ? 'not found' : err.message}`)
    }
  }
  return { items, problems }
}

/** The request as the model receives it: their words, then the files. */
export function composeWithAttachments(text, { items, problems }) {
  if (!items.length && !problems.length) return text
  const ask = text || 'Have a look at what I have attached and tell me briefly what it is.'
  const lines = [
    ask,
    '',
    `[Attached files: ${items.map((i) => i.name).join(' | ') || 'none'}]`,
    ...items.map((i) => `- ${i.name} (${i.note}): ${i.path}`),
    ...problems.map((p) => `- Could not attach ${p}`),
    'Open every attached document and image with the Read tool before answering — images and ' +
      'PDFs show as they are, Word/Excel/PowerPoint arrive as extracted text (audio cannot be ' +
      'read). Then do what I asked with them. Never read file paths aloud.',
  ]
  return lines.join('\n')
}

/** The same request as a person would describe it — for the popup and the journal. */
export function tidyAttached(text) {
  return String(text ?? '')
    .replace(/\n\n\[Attached files: ([^\]\n]*)\][\s\S]*$/, (_, names) => ` 📎 ${names.split(' | ').join(', ')}`)
    .trim()
}
