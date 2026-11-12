import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { protectedProblem, ps, resolveUserPath } from './pc.mjs'
import { windowTitle } from './profile.mjs'

/**
 * Customising JARVIS himself, on request: his look and his voice.
 *
 *   Look  — the user shows a picture ("make your UI look like this") and he
 *           writes a stylesheet, src/custom/user-theme.css, loaded after the
 *           stock one. Vite applies it the moment it is saved; he then
 *           screenshots his own window and compares it with the picture, and
 *           can go round again. Every version is kept in ~/.jarvis/ui-styles,
 *           so undo and reset always work. A stylesheet layer rather than
 *           rewriting the React code: it can change everything that is seen —
 *           colours, fonts, backgrounds, borders, glows, sizes, positions —
 *           and cannot break the assistant underneath.
 *
 *   Voice — the user gives a recording; the browser measures it (pitch, pace,
 *           range, pauses) and he picks the closest installed voice and sets
 *           its speed and pitch to match. Style-matching, not cloning: no
 *           model of anyone's actual voice is made.
 *
 * Only when asked. The prompt (PROMPT_CUSTOMIZE in server.mjs) forbids offering.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const STOCK_CSS = join(REPO, 'src', 'index.css')
export const CUSTOM_CSS = join(REPO, 'src', 'custom', 'user-theme.css')
const BACKUPS = join(homedir(), '.jarvis', 'ui-styles')

const EMPTY_THEME =
  '/* Your own look for JARVIS — written by JARVIS when you ask him to restyle\n' +
  '   himself ("make your UI look like this"), loaded after src/index.css.\n' +
  '   Empty means the stock look. Say "undo the UI change" or "reset your UI". */\n'

/** Tools here that rewrite files; withheld without write access. */
export const CUSTOM_WRITE_TOOLS = new Set([
  'ui_style_apply', 'ui_style_undo', 'ui_style_reset',
  'ui_layout_apply', 'ui_layout_undo', 'ui_layout_reset',
])

// The layout layer: real React code he writes when a picture asks for a
// different arrangement, not just different colours. Checked by the
// TypeScript compiler before it goes live, so a mistake is sent back to him
// to fix instead of breaking the window.
const LAYOUT_TSX = join(REPO, 'src', 'custom', 'CustomLayout.tsx')
const LAYOUT_CSS = join(REPO, 'src', 'custom', 'custom-layout.css')
const LAYOUT_NEXT = join(REPO, 'src', 'custom', 'CustomLayout.next.tsx')
const KIT = join(REPO, 'src', 'custom', 'kit.ts')
const LAYOUT_BACKUPS = join(homedir(), '.jarvis', 'ui-layouts')
const STOCK_LAYOUT =
  '/* No custom layout: the stock interface. JARVIS writes one here when asked to\n' +
  '   restyle himself from a picture (bridge/customize.mjs → ui_layout_apply). */\n' +
  'export default function CustomLayout() {\n' +
  '  return null\n' +
  '}\n'
const HIDE_PARTS = ['frame', 'header', 'telemetry', 'dock', 'suggestions', 'scene', 'scanlines', 'caption', 'hints', 'transcript']

const readText = (f) => {
  try {
    return readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}

function backupLayout() {
  const dir = join(LAYOUT_BACKUPS, new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CustomLayout.tsx'), readText(LAYOUT_TSX))
  writeFileSync(join(dir, 'custom-layout.css'), readText(LAYOUT_CSS))
}

const layoutBackups = () =>
  existsSync(LAYOUT_BACKUPS) ? readdirSync(LAYOUT_BACKUPS).filter((d) => !d.endsWith('.undone')).sort() : []

/** The TypeScript compiler over the app, reporting only errors in `file`. */
export function typecheck(file) {
  const tsc = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc')
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tsc, '--noEmit', '-p', 'tsconfig.app.json', '--pretty', 'false'],
      { cwd: REPO, timeout: 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const name = basename(file)
        const errors = String(stdout ?? '')
          .split(/\r?\n/)
          .filter((l) => l.includes(name))
          .map((l) => l.replace(/^.*?[\\/]src[\\/]custom[\\/]/, ''))
        if (err && err.killed) errors.push('The type check timed out.')
        resolve(errors)
      },
    )
  })
}

/**
 * Every @import in a stylesheet points at Google Fonts. Each import's address
 * is pulled out and checked. (The old one-line pattern let the quote match
 * nothing and then tested the quote itself, so a perfectly good
 * `@import url('https://fonts.googleapis.com/…')` was refused.)
 */
export function onlyGoogleFonts(css) {
  for (const m of String(css).matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]*)/gi)) {
    if (!m[1].toLowerCase().startsWith('https://fonts.googleapis.com/')) return false
  }
  return true
}

/** Plain checks before the compiler: imports and anything with no place in a layout. */
export function layoutProblems(tsx) {
  const problems = []
  for (const m of tsx.matchAll(/^\s*import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm)) {
    if (!['react', './kit', './custom-layout.css'].includes(m[1])) {
      problems.push(`import from "${m[1]}" is not allowed — only 'react', './kit' and './custom-layout.css'`)
    }
  }
  if (!/export\s+default\s+function\s+CustomLayout\b/.test(tsx)) {
    problems.push('there is no `export default function CustomLayout()`')
  }
  // Anything else exported makes the dev server reload the whole page instead
  // of swapping the layout in live — which cut off the conversation.
  for (const m of tsx.matchAll(/^\s*export\s+(?!default\s+function\s+CustomLayout\b)(\S+)/gm)) {
    problems.push(`only the default component may be exported (found \`export ${m[1]}\` — use useHide([...]) for hidden parts)`)
  }
  if (!/\buseHide\s*\(/.test(tsx)) problems.push('call useHide([...]) at the top of the component to name the stock parts it replaces (an empty list is fine)')
  if (/dangerouslySetInnerHTML|\beval\s*\(|new\s+Function\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket|window\.location|document\.cookie|import\s*\(/.test(tsx)) {
    problems.push('it uses something a layout may not (innerHTML, eval, fetch, sockets, navigation, dynamic import) — use the kit instead')
  }
  if (tsx.length > 120_000) problems.push('it is too large (120 KB limit)')
  return problems
}

// Offline transcription: scripts/transcribe.py in the wake listener's Python.
const TRANSCRIBE = join(REPO, 'scripts', 'transcribe.py')
const PYTHON = join(homedir(), '.jarvis', 'wake-venv', 'Scripts', 'python.exe')

/** A 44-byte WAV header for 16-bit mono PCM. */
function wavHeader(bytes, rate) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(bytes, 40)
  return h
}

function runPython(script, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!existsSync(PYTHON)) return reject(new Error('the offline speech engine (~/.jarvis/wake-venv) is not installed'))
    execFile(PYTHON, [script, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n').pop())) : resolve(stdout)))
  })
}

const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.webm', '.flac', '.mp4'])
const MAX_AUDIO = 15 * 1024 * 1024

const ok = (text) => {
  console.log(`[jarvis] customize ok: ${String(text).replace(/\s+/g, ' ').slice(0, 200)}`)
  return { content: [{ type: 'text', text }] }
}
const fail = (text) => {
  console.log(`[jarvis] customize FAILED: ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`)
  return { isError: true, content: [{ type: 'text', text: String(text) }] }
}

const readCustom = () => {
  try {
    return readFileSync(CUSTOM_CSS, 'utf8')
  } catch {
    return ''
  }
}

function writeCustom(css) {
  mkdirSync(dirname(CUSTOM_CSS), { recursive: true })
  writeFileSync(CUSTOM_CSS + '.tmp', css)
  renameSync(CUSTOM_CSS + '.tmp', CUSTOM_CSS)
}

/** Keep the current stylesheet before replacing it. */
function backup() {
  mkdirSync(BACKUPS, { recursive: true })
  const now = readCustom()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(join(BACKUPS, `${stamp}.css`), now)
}

const backups = () =>
  existsSync(BACKUPS) ? readdirSync(BACKUPS).filter((f) => f.endsWith('.css')).sort() : []

/** The stock stylesheet's custom properties and class names: what there is to restyle. */
export function inspectStock() {
  const css = readFileSync(STOCK_CSS, 'utf8')
  const vars = new Map()
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+);/g)) {
    if (!vars.has(m[1])) vars.set(m[1], m[2].trim())
  }
  const classes = new Set()
  // A class in a selector, not a dot inside a URL or a number.
  for (const m of css.matchAll(/(?<![\w/:.-])\.([a-z][\w-]*)/gi)) classes.add(m[1])
  return { vars, classes: [...classes], size: css.length }
}

// The main window: brought up so the user sees the change, then photographed so
// he can check it against the picture they gave him.
const SHOT_CS = String.raw`
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class JShot {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int L, T, R, B; }
  // The window is titled with the assistant's name (setup can rename him); the
  // loading screen is still "J.A.R.V.I.S.".
  static IntPtr Find(string title) {
    IntPtr h = string.IsNullOrEmpty(title) ? IntPtr.Zero : FindWindow(null, title);
    return h != IntPtr.Zero ? h : FindWindow(null, "J.A.R.V.I.S.");
  }
  public static string Show(string title) {
    IntPtr h = Find(title);
    if (h == IntPtr.Zero) return "";
    // Restore only if minimised: SW_RESTORE on a maximised window un-maximises it.
    ShowWindow(h, IsIconic(h) ? 9 : 5);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    return "ok";
  }
  public static bool Shot(string path, string title) {
    IntPtr h = Find(title);
    RECT r; GetWindowRect(h, out r);
    using (var bmp = new Bitmap(Math.Max(1, r.R - r.L), Math.Max(1, r.B - r.T))) {
      // PrintWindow draws only this window — never whatever else is on screen.
      using (var g = Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
      // It can come back black (a GPU-composited window Windows would not
      // repaint for us). Say so rather than hand over an empty picture.
      long sum = 0; int n = 0;
      for (int y = bmp.Height / 10; y < bmp.Height; y += Math.Max(1, bmp.Height / 12))
        for (int x = bmp.Width / 10; x < bmp.Width; x += Math.Max(1, bmp.Width / 12)) {
          var c = bmp.GetPixel(x, y); sum += c.R + c.G + c.B; n++;
        }
      if (n == 0 || sum / n < 6) return false;
      Bitmap outBmp = bmp;
      if (bmp.Width > 1400) outBmp = new Bitmap(bmp, new Size(1400, (int)((long)bmp.Height * 1400 / bmp.Width)));
      var enc = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
      var p = new EncoderParameters(1); p.Param[0] = new EncoderParameter(Encoder.Quality, 80L);
      outBmp.Save(path, enc, p);
    }
    return true;
  }
}`

export async function showAndShoot(waitMs = 1800) {
  const file = join(tmpdir(), `jarvis-ui-${Date.now()}.jpg`)
  const shown = await ps(
    'Add-Type -TypeDefinition $env:JARVIS_CS -ReferencedAssemblies System.Drawing; [void][JShot]::SetProcessDPIAware(); ' +
      '$s = [JShot]::Show($env:JARVIS_T); if (-not $s) { "missing"; return }; Start-Sleep -Milliseconds $env:JARVIS_WAIT; ' +
      'if ([JShot]::Shot($env:JARVIS_F, $env:JARVIS_T)) { "ok" } else { "blank" }',
    { CS: SHOT_CS, F: file, WAIT: waitMs, T: windowTitle() },
    30_000,
  )
  if (shown.trim() !== 'ok') return null
  return (await readFile(file)).toString('base64')
}

/**
 * @param {{ ask: (kind: string, args: object, timeoutMs?: number) => Promise<any>, allowWrites: boolean }} opts
 */
export function customizeServer({ ask, allowWrites }) {
  if (!existsSync(CUSTOM_CSS)) writeCustom(EMPTY_THEME)

  const lookTools = [
    tool(
      'ui_style_inspect',
      'Step one of restyling yourself, ONLY after the user has explicitly asked to customise or ' +
        'change your UI/look/theme. Returns what the interface is made of — its CSS custom ' +
        'properties (colours) with current values, its class names, and the custom stylesheet ' +
        'currently applied — plus a screenshot of how you look right now.',
      {},
      async () => {
        try {
          const { vars, classes } = inspectStock()
          const lines = [
            'CSS custom properties in src/index.css (override them in :root, or per selector):',
            ...[...vars].map(([k, v]) => `  ${k}: ${v}`),
            '',
            `Class names (${classes.length}): ${classes.join(' ')}`,
            '',
            'Notes:',
            '- --accent is re-declared per phase (listening/thinking/tool) and per panel; to recolour',
            '  everything, override --interface and the phase/panel rules that set --accent.',
            '- The arc reactor and 3D scene are a WebGL canvas inside .scene: CSS cannot recolour its',
            '  pixels, but filter on .scene (hue-rotate, saturate, brightness) and its opacity can.',
            '  ui_theme also retints it for this session.',
            '- body::after draws the scanlines and vignette. .hud is the overlay of rings, rails and text.',
            '- Fonts: @import from fonts.googleapis.com works (put @import lines first).',
            '- Use !important where a stock rule is more specific.',
            '',
            'Custom stylesheet now applied (src/custom/user-theme.css):',
            readCustom().trim() || '(empty — the stock look)',
          ]
          const shot = await showAndShoot(300).catch(() => null)
          return {
            content: [
              { type: 'text', text: lines.join('\n') },
              ...(shot ? [{ type: 'image', data: shot, mimeType: 'image/jpeg' }] : []),
            ],
          }
        } catch (err) {
          return fail(`Could not inspect the interface: ${err.message}`)
        }
      },
    ),
    tool(
      'ui_layout_inspect',
      'Step one of rebuilding your interface from a picture, ONLY after the user explicitly asked ' +
        'to customise/change your UI. Returns the current custom layout (React + CSS), the kit it ' +
        'may use (live data and actions), the stock parts it can hide, and a screenshot of you now.',
      {},
      async () => {
        const shot = await showAndShoot(300).catch(() => null)
        const text = [
          'Current src/custom/CustomLayout.tsx:',
          '```tsx',
          readText(LAYOUT_TSX).trim(),
          '```',
          '',
          'Current src/custom/custom-layout.css:',
          '```css',
          readText(LAYOUT_CSS).trim() || '/* empty */',
          '```',
          '',
          'The kit — src/custom/kit.ts, the ONLY thing besides react a layout may import:',
          '```ts',
          readText(KIT).trim(),
          '```',
          '',
          `Stock parts a layout can hide with useHide([...]) at the top of the component: ${HIDE_PARTS.join(', ')}.`,
          'Rules: import only from "react", "./kit" and "./custom-layout.css"; the ONLY export is',
          '`export default function CustomLayout()` (anything else exported reloads the page and cuts',
          'off this conversation). The layout is drawn over the 3D scene and under the HUD\'s live',
          'parts (panels, article blades, transcript, tool badge), which stay. Root element: position',
          'fixed, inset 0, pointer-events none, with pointer-events auto on anything clickable. Use',
          'vw/vh so it fits any window. Every figure must be real (kit) — no made-up numbers.',
        ].join('\n')
        return {
          content: [
            { type: 'text', text },
            ...(shot ? [{ type: 'image', data: shot, mimeType: 'image/jpeg' }] : []),
          ],
        }
      },
    ),
    ...(allowWrites
      ? [
          tool(
            'ui_layout_apply',
            'Rebuild your interface to match a picture the user gave — ONLY after they explicitly ' +
              'asked to customise/change your UI. Use this (not ui_style_apply) whenever the picture ' +
              'has a different arrangement: sidebars, cards, widgets, a different centrepiece, an ' +
              'input bar. Call ui_layout_inspect first. Write the COMPLETE React component (tsx) and ' +
              'its COMPLETE stylesheet (css) reproducing the picture as closely as you can — layout, ' +
              'colours, fonts, shapes, glow — with live data from the kit. It is type-checked before ' +
              'it goes live: if there are errors nothing changes and you get them back to fix. On ' +
              'success the old layout is backed up and you get a screenshot: compare with the picture ' +
              'and apply again to get closer (at most three rounds).',
            {
              tsx: z.string().describe('The whole src/custom/CustomLayout.tsx.'),
              css: z.string().describe('The whole src/custom/custom-layout.css.'),
              description: z.string().describe('One line describing the design.'),
            },
            async ({ tsx, css, description }) => {
              const code = String(tsx ?? '')
              const style = String(css ?? '')
              const problems = layoutProblems(code)
              if (/<\/?script|javascript:|expression\s*\(/i.test(style)) problems.push('the stylesheet must be plain CSS')
              if (!onlyGoogleFonts(style)) {
                problems.push('the stylesheet may only @import Google Fonts')
              }
              if (problems.length) return fail(`Not applied: ${problems.join('; ')}.`)
              try {
                writeFileSync(LAYOUT_NEXT, code)
                const errors = await typecheck(LAYOUT_NEXT)
                rmSync(LAYOUT_NEXT, { force: true })
                if (errors.length) {
                  return fail(`Not applied — the layout does not compile. Fix these and apply again:\n${errors.slice(0, 25).join('\n')}`)
                }
                const previous = { tsx: readText(LAYOUT_TSX), css: readText(LAYOUT_CSS) }
                backupLayout()
                const header = `/* ${String(description ?? '').replace(/\*\//g, '').slice(0, 200)} — ${new Date().toLocaleString('en-IN')} */\n`
                writeFileSync(LAYOUT_CSS, header + style.trim() + '\n')
                writeFileSync(LAYOUT_TSX, code.trim() + '\n')
                console.log(`[jarvis] custom layout applied: ${description}`)
                // Swapped in live; bring the window up so it can be checked.
                const shot = await showAndShoot(2500).catch(() => null)
                // Did it render, and does it run smoothly? Rolled back if not,
                // so a broken or sluggish layout never stays on screen.
                let check = null
                try {
                  check = await ask('layout-check', {}, 15_000)
                } catch {
                  /* window not connected: nothing to measure */
                }
                const broken = check?.layoutError
                const slow = typeof check?.fps === 'number' && check.fps < 20
                if (broken || slow) {
                  writeFileSync(LAYOUT_TSX, previous.tsx || STOCK_LAYOUT)
                  writeFileSync(LAYOUT_CSS, previous.css)
                  console.log(`[jarvis] custom layout rolled back: ${broken ? `crashed (${broken})` : `${check.fps} fps`}`)
                  return fail(
                    broken
                      ? `Rolled back — the layout crashed while rendering: ${broken}. Fix it and apply again.`
                      : `Rolled back — the layout ran at only ${check.fps} frames a second (needs 20+). Use fewer or lighter animations and filters, and apply again.`,
                  )
                }
                return {
                  content: [
                    {
                      type: 'text',
                      text:
                        'Applied and saved (it stays after a restart)' +
                        (typeof check?.fps === 'number' ? `, rendering cleanly at ${check.fps} fps. ` : '. ') +
                        (shot
                          ? 'Here is how you look now — compare it with their picture; apply again if anything is clearly off.'
                          : 'Your window could not be photographed, so ask the user how it looks.'),
                    },
                    ...(shot ? [{ type: 'image', data: shot, mimeType: 'image/jpeg' }] : []),
                  ],
                }
              } catch (err) {
                rmSync(LAYOUT_NEXT, { force: true })
                return fail(`Could not apply the layout: ${err.message}`)
              }
            },
          ),
          tool(
            'ui_layout_undo',
            'Go back to the layout before the last change ("undo that", "bring back the previous look").',
            {},
            async () => {
              const list = layoutBackups()
              if (!list.length) return ok('There is no earlier layout to go back to.')
              const dir = join(LAYOUT_BACKUPS, list[list.length - 1])
              writeFileSync(LAYOUT_CSS, readText(join(dir, 'custom-layout.css')))
              writeFileSync(LAYOUT_TSX, readText(join(dir, 'CustomLayout.tsx')) || STOCK_LAYOUT)
              renameSync(dir, `${dir}.undone`)
              return ok('Restored the previous layout.')
            },
          ),
          tool(
            'ui_layout_reset',
            'Back to the original stock interface ("reset your UI", "go back to your normal look"). ' +
              'Also call ui_style_reset so no custom colours remain. The current layout is backed up.',
            {},
            async () => {
              backupLayout()
              writeFileSync(LAYOUT_CSS, '/* No custom layout. */\n')
              writeFileSync(LAYOUT_TSX, STOCK_LAYOUT)
              return ok('Back to the stock interface.')
            },
          ),
          tool(
            'ui_style_apply',
            'Restyle yourself to match what the user asked for — ONLY after they explicitly asked to ' +
              'customise/change your UI (e.g. they gave a picture and said "make your UI look like ' +
              'this"). Write the COMPLETE stylesheet (it replaces the previous custom one; include ' +
              'everything you still want) that turns the stock interface into that style: colours, ' +
              'fonts, backgrounds, gradients, borders, corner radius, glows, panel shapes, sizes and ' +
              'positions. Call ui_style_inspect first. It is saved, applied live, and the previous ' +
              'version is backed up. Returns a screenshot of the result: compare it with their ' +
              'picture and apply again to get closer — up to three rounds. Plain CSS only.',
            {
              css: z.string().describe('The whole custom stylesheet.'),
              description: z.string().describe('One line: the style, e.g. "white glass, blue accents, rounded panels".'),
            },
            async ({ css, description }) => {
              const text = String(css ?? '')
              if (!text.trim()) return fail('The stylesheet is empty — use ui_style_reset for the stock look.')
              if (text.length > 80_000) return fail('That stylesheet is too large (80 KB limit).')
              if (/<\/?script|javascript:|expression\s*\(|behavior\s*:/i.test(text)) {
                return fail('Only plain CSS is allowed.')
              }
              if (!onlyGoogleFonts(text)) {
                return fail('Only Google Fonts may be imported.')
              }
              try {
                backup()
                const header = `/* ${String(description ?? '').replace(/\*\//g, '').slice(0, 200)} — ${new Date().toLocaleString('en-IN')} */\n`
                writeCustom(header + text.trim() + '\n')
                const shot = await showAndShoot().catch(() => null)
                return {
                  content: [
                    {
                      type: 'text',
                      text:
                        'Applied and saved (it stays after a restart). ' +
                        (shot
                          ? 'Here is how you look now — compare it with their picture; apply again if anything is clearly off.'
                          : 'Your window could not be photographed, so check by asking the user.'),
                    },
                    ...(shot ? [{ type: 'image', data: shot, mimeType: 'image/jpeg' }] : []),
                  ],
                }
              } catch (err) {
                return fail(`Could not apply the style: ${err.message}`)
              }
            },
          ),
          tool(
            'ui_style_undo',
            'Go back to the look before the last change ("undo that", "I preferred the previous one").',
            {},
            async () => {
              const list = backups()
              if (!list.length) return ok('There is no earlier look to go back to.')
              const last = join(BACKUPS, list[list.length - 1])
              writeCustom(readFileSync(last, 'utf8') || EMPTY_THEME)
              renameSync(last, last.replace(/\.css$/, '.undone'))
              await showAndShoot(300).catch(() => null)
              return ok('Restored the previous look.')
            },
          ),
          tool(
            'ui_style_reset',
            'Back to the original stock look ("reset your UI", "go back to your normal look"). The ' +
              'custom style is backed up first.',
            {},
            async () => {
              backup()
              writeCustom(EMPTY_THEME)
              return ok('Back to the stock look.')
            },
          ),
        ]
      : []),
  ]

  const voiceTools = [
    tool(
      'transcribe_audio',
      'Write out what is said in an audio recording — a voice note, lecture, call or meeting the ' +
        'user attached or named ("transcribe this", "what does this recording say", "summarise ' +
        'this voice note"). Offline, on this PC. Up to ten minutes; accuracy is good for clear ' +
        'English and rougher for noisy audio or other languages — say so if the text looks garbled.',
      { path: z.string().describe('The audio file: an attached path, or e.g. "downloads\\\\note.m4a".') },
      async ({ path }) => {
        try {
          const file = await resolveUserPath(path)
          const bad = protectedProblem(file)
          if (bad) return fail(`Refused: ${bad}.`)
          const ext = extname(file).toLowerCase()
          if (!AUDIO.has(ext)) return fail(`${ext || 'That'} is not an audio file I can read.`)
          if ((await stat(file)).size > 40 * 1024 * 1024) return fail('That recording is too large (40 MB limit).')
          const data = (await readFile(file)).toString('base64')
          const reply = await ask('audio-pcm', { data }, 120_000)
          if (reply?.error) return fail(`Could not decode it: ${reply.error}`)
          const pcm = Buffer.from(String(reply.pcm ?? ''), 'base64')
          if (!pcm.length) return fail('The recording is empty.')
          const wav = join(tmpdir(), `jarvis-transcribe-${Date.now()}.wav`)
          writeFileSync(wav, Buffer.concat([wavHeader(pcm.length, 16000), pcm]))
          try {
            const text = await runPython(TRANSCRIBE, [wav], 600_000)
            return ok(
              (text.trim() ? `Transcript (${reply.seconds}s of audio):\n${text.trim()}` : 'No speech was recognised in it.') +
                (reply.truncated ? '\n(Only the first ten minutes were transcribed.)' : ''),
            )
          } finally {
            rmSync(wav, { force: true })
          }
        } catch (err) {
          return fail(err.code === 'ENOENT' ? 'That file does not exist.' : `Could not transcribe it: ${err.message}`)
        }
      },
    ),
    tool(
      'voice_analyze',
      'Measure a voice recording the user gave you — ONLY after they explicitly asked to customise ' +
        'or change your voice ("make your voice like this", "change your voice to sound like this ' +
        'recording"). Takes an attached audio file (mp3, wav, m4a, ogg, webm, flac) or a path. ' +
        'Returns its pitch, pace, range and pauses, a suggested setting, and the voices installed ' +
        'on this PC. Then call voice_set. This matches the style of the recording with an ' +
        'installed voice — it does not clone anyone; say so if they ask for an exact copy.',
      { path: z.string().describe('The audio file: an attached path, or e.g. "downloads\\\\sample.mp3".') },
      async ({ path }) => {
        try {
          const file = await resolveUserPath(path)
          const bad = protectedProblem(file)
          if (bad) return fail(`Refused: ${bad}.`)
          const ext = extname(file).toLowerCase()
          if (!AUDIO.has(ext)) return fail(`${ext || 'That'} is not an audio file I can read.`)
          const size = (await stat(file)).size
          if (size > MAX_AUDIO) return fail('That recording is too large (15 MB limit) — a 10 to 60 second clip is plenty.')
          const data = (await readFile(file)).toString('base64')
          const reply = await ask('voice-analyze', { data, ext }, 60_000)
          if (reply?.error) return fail(reply.error)
          return ok(
            'Measured from the recording:\n' +
              JSON.stringify(reply.features, null, 2) +
              '\n\nSuggested: ' + JSON.stringify(reply.suggestion) +
              '\n\nInstalled voices (name — language):\n' +
              (reply.voices ?? []).map((v) => `- ${v.name} — ${v.lang}`).join('\n') +
              '\n\nPick the voice whose gender and accent fit (the user may have said, e.g. "British", ' +
              '"female", "deeper"), then voice_set with rate and pitch from the suggestion, adjusted to ' +
              'what they asked. Rate 1.0 is the voice\'s normal pace; pitch 1.0 its normal pitch.',
          )
        } catch (err) {
          return fail(err.code === 'ENOENT' ? 'That file does not exist.' : `Could not analyse it: ${err.message}`)
        }
      },
    ),
    tool(
      'voice_set',
      'Change your speaking voice — ONLY after the user explicitly asked to customise or change ' +
        'your voice (from a recording via voice_analyze, or plainly: "speak faster", "use a ' +
        'female voice", "make your voice deeper"). Saved; it stays after a restart. Your next ' +
        'sentence is spoken in the new voice, so confirm in one short line.',
      {
        voice: z.string().optional().describe('Installed voice name, or part of it, e.g. "Google UK English Female". Omit to keep the current voice.'),
        rate: z.number().optional().describe('0.6–1.8; 1.0 normal.'),
        pitch: z.number().optional().describe('0.5–1.5; 1.0 normal, lower is deeper.'),
      },
      async ({ voice, rate, pitch }) => {
        try {
          const reply = await ask('voice-set', { voice: voice ?? null, rate: rate ?? null, pitch: pitch ?? null }, 15_000)
          if (reply?.error) return fail(reply.error)
          return ok(`Voice set: ${reply.voice} at rate ${reply.rate}, pitch ${reply.pitch}.`)
        } catch (err) {
          return fail(`Could not change the voice: ${err.message}`)
        }
      },
    ),
    tool(
      'voice_reset',
      'Go back to your default voice ("use your old voice", "reset your voice").',
      {},
      async () => {
        try {
          const reply = await ask('voice-set', { reset: true }, 15_000)
          if (reply?.error) return fail(reply.error)
          return ok(`Back to the default voice: ${reply.voice}.`)
        } catch (err) {
          return fail(`Could not reset the voice: ${err.message}`)
        }
      },
    ),
  ]

  return createSdkMcpServer({
    name: 'jarvis_custom',
    version: '1.0.0',
    instructions:
      'Customising your own look and voice — use those tools ONLY when the user explicitly asks to ' +
      'customise or change your UI or voice; never offer, suggest or ask whether they want to. ' +
      'Also transcribe_audio, for writing out what is said in a recording whenever that helps.',
    tools: [...lookTools, ...voiceTools],
  })
}
