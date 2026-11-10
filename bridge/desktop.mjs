import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Desktop helpers for jarvis_pc: seeing the screen, typing into other apps,
 * system status, brightness, playing media and power.
 *
 * Window work goes through a small C# helper compiled by PowerShell on each
 * call. "The window the user means" is the top-most real window that is not
 * Jarvis itself: the user is talking to the Jarvis window, so it is almost
 * always in front, and capturing or typing into it would be useless.
 */

/** Shared PowerShell runner from pc.mjs, injected to avoid a circular import. */
let ps = null

const WIN_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class JWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public struct RECT { public int L, T, R, B; }

  static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }

  static bool Real(IntPtr h) {
    if (!IsWindowVisible(h) || IsIconic(h)) return false;
    int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4);
    if (cloaked != 0) return false;
    var t = Title(h);
    if (t.Length == 0 || t == "Program Manager" || t.Contains("J.A.R.V.I.S")) return false;
    RECT r; GetWindowRect(h, out r);
    return (r.R - r.L) > 200 && (r.B - r.T) > 150;
  }

  /** Top-most real window, or the first whose title contains want. */
  public static IntPtr Pick(string want) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!Real(h)) return true;
      if (string.IsNullOrEmpty(want) || Title(h).IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string List() {
    var all = new List<string>();
    EnumWindows((h, l) => { if (Real(h)) all.Add(Title(h)); return true; }, IntPtr.Zero);
    return string.Join("\n", all);
  }

  public static string TitleOf(IntPtr h) { return Title(h); }

  static void SaveJpeg(Bitmap bmp, string path) {
    int maxW = 1600;
    Bitmap outBmp = bmp;
    if (bmp.Width > maxW) {
      int h = (int)((long)bmp.Height * maxW / bmp.Width);
      outBmp = new Bitmap(bmp, new Size(maxW, h));
    }
    var enc = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
    var ps = new EncoderParameters(1);
    ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
    outBmp.Save(path, enc, ps);
  }

  /** Captures a window even when other windows cover it. */
  public static void CaptureWindow(IntPtr h, string path) {
    RECT r; GetWindowRect(h, out r);
    using (var bmp = new Bitmap(r.R - r.L, r.B - r.T)) {
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc();
        PrintWindow(h, hdc, 2);
        g.ReleaseHdc(hdc);
      }
      SaveJpeg(bmp, path);
    }
  }

  public static void CaptureScreen(string path) {
    var b = System.Windows.Forms.Screen.PrimaryScreen.Bounds;
    using (var bmp = new Bitmap(b.Width, b.Height)) {
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(b.Left, b.Top, 0, 0, b.Size);
      SaveJpeg(bmp, path);
    }
  }

  /** Bring a window to the front. The Alt tap lets a background process do it. */
  public static void Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
  }
}
`

const PRELUDE =
  'Add-Type -TypeDefinition $env:JARVIS_CS -ReferencedAssemblies System.Drawing,System.Windows.Forms; ' +
  '[void][JWin]::SetProcessDPIAware(); '

const win = (script, args = {}, timeoutMs = 30_000) => ps(PRELUDE + script, { CS: WIN_CS, ...args }, timeoutMs)

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text: String(text?.message ?? text) }] })

/** Top result of a YouTube search, without an API key. */
export async function youtubeFirst(query) {
  const res = await fetch(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`,
    { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36', 'accept-language': 'en' } },
  )
  const html = await res.text()
  const m = html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,2000}?"title":\{"runs":\[\{"text":"([^"]+)"/)
  if (m) return { id: m[1], title: m[2] }
  const id = html.match(/"videoId":"([\w-]{11})"/)?.[1]
  return id ? { id, title: query } : null
}

/** Tools here that act on the world; withheld without write access. */
export const DESKTOP_WRITE_TOOLS = ['type_text', 'power']

/**
 * @param {{ allowWrites: boolean, ps: Function }} opts
 * @returns {{ safe: any[], writes: any[] }}
 */
export function desktopTools({ allowWrites, ps: runner }) {
  ps = runner

  const safe = [
    tool(
      'screen_capture',
      'See the screen. "window" (default) captures the window the user is working in — the ' +
        'top-most window that is not Jarvis, even if Jarvis covers it — or the window whose ' +
        'title contains window_title. "screen" captures the whole primary screen as it looks ' +
        '(Jarvis included if it is in front). Returns the image so you can read and explain ' +
        'it: errors, questions, a page, a form. Use for "what is on my screen", "explain this ' +
        'error", "read this", "summarise this page".',
      {
        target: z.enum(['window', 'screen']).optional(),
        window_title: z.string().optional().describe('Part of the window title, e.g. "Chrome", "Word", "VS Code".'),
      },
      async ({ target, window_title }) => {
        const file = join(tmpdir(), `jarvis-screen-${Date.now()}.jpg`)
        try {
          let title = 'the screen'
          if (target === 'screen') {
            await win('[JWin]::CaptureScreen($env:JARVIS_F)', { F: file })
          } else {
            title = await win(
              '$h = [JWin]::Pick($env:JARVIS_W); if ($h -eq [IntPtr]::Zero) { throw "no matching window" }; ' +
                '[JWin]::CaptureWindow($h, $env:JARVIS_F); [JWin]::TitleOf($h)',
              { F: file, W: window_title ?? '' },
            )
          }
          const data = (await readFile(file)).toString('base64')
          console.log(`[jarvis] pc ok: captured ${title}`)
          return {
            content: [
              { type: 'text', text: `Captured: ${title}. Saved at ${file} (open it on a blade if they want to see it).` },
              { type: 'image', data, mimeType: 'image/jpeg' },
            ],
          }
        } catch (err) {
          console.log(`[jarvis] pc FAILED: capture: ${err.message}`)
          return fail(
            /no matching window/.test(err.message)
              ? `No open window matches "${window_title}".`
              : `Could not capture: ${err.message}`,
          )
        }
      },
    ),
    tool(
      'list_windows',
      'List the titles of the open windows, front to back (Jarvis excluded).',
      {},
      async () => {
        try {
          return ok((await win('[JWin]::List()')) || 'No windows are open.')
        } catch (err) {
          return fail(err)
        }
      },
    ),
    tool(
      'system_status',
      'Battery level and charging state, Wi-Fi network and signal, screen brightness, free ' +
        'space on C:, memory use and uptime.',
      {},
      async () => {
        try {
          const out = await ps(`
$o = @()
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
if ($b) { $st = @{1='on battery';2='plugged in';3='fully charged';6='charging';7='charging';8='charging';9='charging'}[[int]$b.BatteryStatus]; if (-not $st) { $st = 'status ' + $b.BatteryStatus }; $o += "Battery: $($b.EstimatedChargeRemaining)% ($st)" } else { $o += 'Battery: none (desktop)' }
$w = netsh wlan show interfaces 2>$null | Out-String
$ssid = [regex]::Match($w, '(?m)^\\s*SSID\\s*:\\s*(.+)$').Groups[1].Value.Trim()
$sig = [regex]::Match($w, '(?m)^\\s*Signal\\s*:\\s*(.+)$').Groups[1].Value.Trim()
if ($ssid) { $o += "Wi-Fi: $ssid ($sig)" } else { $o += 'Wi-Fi: not connected' }
try { $br = (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness; $o += "Brightness: $br%" } catch {}
$d = Get-PSDrive C; $o += "C: drive: $([math]::Round($d.Free/1GB,1)) GB free of $([math]::Round(($d.Used+$d.Free)/1GB,0)) GB"
$os = Get-CimInstance Win32_OperatingSystem
$o += "Memory: $([math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB,1)) of $([math]::Round($os.TotalVisibleMemorySize/1MB,1)) GB in use"
$up = (Get-Date) - $os.LastBootUpTime; $o += "Up for $([int][math]::Floor($up.TotalHours)) hours $($up.Minutes) minutes"
$o -join [Environment]::NewLine`)
          return ok(out)
        } catch (err) {
          return fail(err)
        }
      },
    ),
    tool(
      'set_brightness',
      'Set the laptop screen brightness, 0 to 100.',
      { level: z.number() },
      async ({ level }) => {
        const v = Math.max(0, Math.min(100, Math.round(level)))
        try {
          await ps(
            '(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1) | ' +
              'Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout=[uint32]1; Brightness=[byte]$env:JARVIS_V} | Out-Null',
            { V: v },
          )
          return ok(`Brightness ${v} percent.`)
        } catch {
          return fail('This screen does not allow brightness control from Windows (common on external monitors).')
        }
      },
    ),
    tool(
      'play_media',
      'Play something. "youtube" opens the top YouTube result for the query in the browser and ' +
        'it starts playing. "spotify" opens Spotify searching for it (the user may need to ' +
        'press play). For pause/next/volume use media_control.',
      { query: z.string(), where: z.enum(['youtube', 'spotify']).optional() },
      async ({ query, where }) => {
        try {
          if ((where ?? 'youtube') === 'spotify') {
            await ps('Start-Process -FilePath $env:JARVIS_U', { U: `spotify:search:${encodeURIComponent(query)}` })
            return ok(`Spotify is searching for ${query}.`)
          }
          const hit = await youtubeFirst(query)
          const url = hit
            ? `https://www.youtube.com/watch?v=${hit.id}`
            : `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
          await ps('Start-Process -FilePath $env:JARVIS_U', { U: url })
          return ok(hit ? `Playing "${hit.title}" on YouTube.` : `Opened YouTube results for ${query}.`)
        } catch (err) {
          return fail(err)
        }
      },
    ),
  ]

  const writes = [
    tool(
      'type_text',
      'Type text into the window the user is working in (the top-most window that is not ' +
        'Jarvis), or the window whose title contains window_title. Pastes it, so any ' +
        'language and emoji work. press_enter sends Enter afterwards — only when they asked ' +
        'to send or submit. Their clipboard is restored afterwards.',
      {
        text: z.string(),
        window_title: z.string().optional(),
        press_enter: z.boolean().optional(),
      },
      async ({ text, window_title, press_enter }) => {
        try {
          const title = await win(
            `
$h = [JWin]::Pick($env:JARVIS_W); if ($h -eq [IntPtr]::Zero) { throw "no matching window" }
$old = $null; try { $old = Get-Clipboard -Raw -ErrorAction Stop } catch {}
Set-Clipboard -Value $env:JARVIS_T
[JWin]::Focus($h); Start-Sleep -Milliseconds 350
[System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 250
if ($env:JARVIS_E -eq '1') { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }
Start-Sleep -Milliseconds 300
if ($null -ne $old) { Set-Clipboard -Value $old }
[JWin]::TitleOf($h)`,
            { W: window_title ?? '', T: text, E: press_enter ? '1' : '0' },
          )
          console.log(`[jarvis] pc ok: typed into ${title}`)
          return ok(`Typed into ${title}.`)
        } catch (err) {
          return fail(/no matching window/.test(err.message) ? 'There is no window to type into.' : err)
        }
      },
    ),
    tool(
      'power',
      'Shut down, restart or sleep the PC, or cancel a pending shutdown. Shutdown and restart ' +
        'wait 60 seconds so they can still be cancelled. ONLY call with confirmed=true after ' +
        'you asked "Shall I shut down?" (or similar) and the user said yes in their reply.',
      {
        action: z.enum(['shutdown', 'restart', 'sleep', 'cancel']),
        confirmed: z.boolean().describe('True only if the user explicitly confirmed this action.'),
      },
      async ({ action, confirmed }) => {
        if (action !== 'cancel' && !confirmed) {
          return fail('Not confirmed. Ask the user first, then call again with confirmed=true.')
        }
        try {
          if (action === 'shutdown') await ps('shutdown.exe /s /t 60')
          else if (action === 'restart') await ps('shutdown.exe /r /t 60')
          else if (action === 'cancel') await ps('shutdown.exe /a')
          else await ps('Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState("Suspend", $false, $false)')
          return ok(
            action === 'cancel' ? 'Shutdown cancelled.'
            : action === 'sleep' ? 'Sleeping.'
            : `${action === 'shutdown' ? 'Shutting down' : 'Restarting'} in sixty seconds. Say cancel to stop it.`,
          )
        } catch (err) {
          return fail(action === 'cancel' ? 'There was no shutdown to cancel.' : err)
        }
      },
    ),
  ]

  return { safe, writes: allowWrites ? writes : [] }
}
