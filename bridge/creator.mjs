/**
 * Creative skills: websites, images, voiceovers, reels from a script, and
 * video editing.
 *
 *   create_website   writes a site's files into Documents\Jarvis Projects\<name>
 *                    and opens it in the browser
 *   generate_image   a picture from a description (Gemini image model)
 *   voiceover        speech from text to a WAV file (Gemini's voices; the
 *                    Windows voice offline or without a key)
 *   make_reel        a video from a script: per scene a generated image, the
 *                    narration voiced, subtitles, a slow zoom — joined into an
 *                    MP4 (9:16 for reels by default)
 *   generate_video_clip  a real AI video clip with Google's Veo, when the
 *                    Gemini key has access to it (it needs billing enabled)
 *   edit_video       trim, speed, crop to an aspect, add text, mute, add
 *                    music, add a voiceover, join clips — with ffmpeg
 *
 * Gemini does the images, voices and Veo video whichever brain is answering
 * (Claude stays in charge and calls these tools). ffmpeg does the editing,
 * on this PC. Outputs: Videos\Jarvis, Pictures\Jarvis, Music\Jarvis.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path'
import { readKeys } from './brain.mjs'

export const CREATOR_WRITE_TOOLS = new Set([
  'create_website', 'generate_image', 'voiceover', 'make_reel', 'generate_video_clip', 'edit_video',
])

const HOME = homedir()
const OUT = {
  videos: join(HOME, 'Videos', 'Jarvis'),
  pictures: join(HOME, 'Pictures', 'Jarvis'),
  music: join(HOME, 'Music', 'Jarvis'),
  sites: join(HOME, 'Documents', 'Jarvis Projects'),
}
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta'

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const failText = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const safeName = (s, fallback) =>
  (String(s ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || fallback)
const outFile = (dir, name, ext) => {
  mkdirSync(dir, { recursive: true })
  let f = join(dir, `${safeName(name, 'jarvis')}${ext}`)
  for (let i = 2; existsSync(f); i++) f = join(dir, `${safeName(name, 'jarvis')} (${i})${ext}`)
  return f
}
const geminiKey = () => readKeys().gemini?.key || null
const openFile = (f) => spawn('cmd.exe', ['/c', 'start', '""', f], { detached: true, stdio: 'ignore', windowsHide: true }).unref()

// ---------------------------------------------------------------- ffmpeg

/** ffmpeg on PATH, or where winget put it (the bridge may predate the PATH change). */
export function findTool(name) {
  const exe = `${name}.exe`
  for (const d of (process.env.PATH ?? '').split(';')) {
    if (d && existsSync(join(d, exe))) return join(d, exe)
  }
  const links = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', exe)
  if (existsSync(links)) return links
  const pk = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages')
  try {
    for (const p of readdirSync(pk).filter((d) => /ffmpeg/i.test(d))) {
      for (const sub of readdirSync(join(pk, p))) {
        const f = join(pk, p, sub, 'bin', exe)
        if (existsSync(f)) return f
      }
    }
  } catch {
    /* not installed */
  }
  return null
}

function run(file, args, timeoutMs = 15 * 60_000) {
  return new Promise((res, rej) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return rej(new Error(String(stderr || err.message).trim().split('\n').slice(-3).join(' ')))
      res(String(stdout))
    })
  })
}

async function ffmpeg(args) {
  const f = findTool('ffmpeg')
  if (!f) throw new Error('ffmpeg is not installed (winget install Gyan.FFmpeg).')
  return run(f, ['-hide_banner', '-loglevel', 'error', '-y', ...args])
}

const probe = (args, file) => run(findTool('ffprobe'), ['-v', 'error', ...args, '-of', 'csv=p=0', file], 30_000)

async function duration(file) {
  if (!findTool('ffprobe')) return null
  const d = parseFloat(await probe(['-show_entries', 'format=duration'], file))
  return Number.isFinite(d) ? d : null
}
const videoSize = async (file) =>
  (await probe(['-select_streams', 'v:0', '-show_entries', 'stream=width,height'], file)).trim().split(',').map(Number)
const hasAudio = async (file) => Boolean((await probe(['-select_streams', 'a', '-show_entries', 'stream=index'], file)).trim())

/** A path for ffmpeg's filter syntax: forward slashes, the drive colon escaped. */
const filterPath = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:')

const SIZES = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350] }
const FONT = existsSync('C:/Windows/Fonts/segoeuib.ttf') ? 'C:/Windows/Fonts/segoeuib.ttf' : 'C:/Windows/Fonts/arial.ttf'

/** Wrap text into lines of about `width` characters, for subtitles. */
function wrap(s, width) {
  const lines = []
  let line = ''
  for (const w of String(s).split(/\s+/)) {
    if ((line + ' ' + w).trim().length > width && line) {
      lines.push(line)
      line = w
    } else line = (line + ' ' + w).trim()
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

/** A drawtext filter that shows the text in `file` (no escaping troubles). */
function drawText(file, { w, h, place = 'bottom', size }) {
  const fs = size ?? Math.round(Math.min(w, h) / 17)
  const y = place === 'top' ? `${Math.round(h * 0.08)}` : place === 'center' ? '(h-text_h)/2' : `h-text_h-${Math.round(h * 0.12)}`
  return (
    `drawtext=fontfile='${filterPath(FONT)}':textfile='${filterPath(file)}':fontcolor=white:fontsize=${fs}` +
    `:line_spacing=${Math.round(fs * 0.3)}:x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.45:boxborderw=${Math.round(fs * 0.45)}`
  )
}

// ---------------------------------------------------------------- Gemini

async function gemini(model, body, timeoutMs = 120_000) {
  const key = geminiKey()
  if (!key) throw new Error('No Gemini key — add one in Customize (it is free).')
  const r = await fetch(`${GEMINI}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error?.message?.split('\n')[0] ?? `Gemini ${r.status}`)
  return j
}

const inline = (j) => (j.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData)?.inlineData ?? null

/** Try models in order; the first that answers wins (free models get busy). */
async function firstOf(models, body, timeoutMs) {
  let last
  for (const m of models) {
    try {
      const j = await gemini(m, body, timeoutMs)
      if (inline(j)) return { j, model: m }
      last = new Error('no output')
    } catch (err) {
      last = err
    }
  }
  throw last ?? new Error('no model answered')
}

const IMAGE_MODELS = ['gemini-2.5-flash-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image']
// 3.8 and 3.1 answered on a free key; 2.5 refused short lines ("tried to generate text").
const TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts']
export const VOICES = ['Kore', 'Puck', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr']

let lastFreeImage = 0

/** Pixel size for an aspect ratio, for the free image service. */
const PIXELS = { '1:1': [1024, 1024], '9:16': [1080, 1920], '16:9': [1920, 1080], '4:5': [1080, 1350], '3:4': [1080, 1440], '4:3': [1440, 1080] }

/**
 * An image from a description: Gemini's image model first; if this key has no
 * image quota (the free tier has none — "exceeded your current quota",
 * measured), Pollinations, a free public image generator that needs no key.
 */
export async function makeImage(prompt, aspect, file) {
  if (geminiKey()) {
    try {
      const { j } = await firstOf(
        IMAGE_MODELS,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } },
        },
        150_000,
      )
      writeFileSync(file, Buffer.from(inline(j).data, 'base64'))
      return file
    } catch (err) {
      console.log(`[jarvis] Gemini image unavailable (${String(err.message).slice(0, 80)}) - using Pollinations`)
    }
  }
  const [w, h] = PIXELS[aspect] ?? PIXELS['1:1']
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 900))}` +
    `?width=${w}&height=${h}&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    // Free use allows one image every 45 s per connection ("FREE_LIMIT",
    // measured): space requests out, and wait as long as it says when asked.
    const gap = lastFreeImage + 46_000 - Date.now()
    if (gap > 0) await new Promise((res) => setTimeout(res, gap))
    try {
      lastFreeImage = Date.now()
      const r = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      const type = r.headers.get('content-type') ?? ''
      if (r.ok && type.startsWith('image/')) {
        writeFileSync(file, Buffer.from(await r.arrayBuffer()))
        return file
      }
      lastErr = new Error(`image service answered ${r.status}`)
      const wait = Number(r.headers.get('retry-after'))
      if (Number.isFinite(wait) && wait > 0 && wait < 120) await new Promise((res) => setTimeout(res, wait * 1000 + 500))
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`No image could be made (Gemini needs billing for images; the free service failed: ${lastErr?.message}).`)
}

/** 16-bit mono PCM to a WAV file. */
function wav(pcm, rate) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** Speech to a WAV: Gemini's voices, or the Windows voice without a key / internet. */
export async function speak(say, voice, file) {
  if (geminiKey()) {
    try {
      const { j } = await firstOf(
        TTS_MODELS,
        {
          contents: [{ parts: [{ text: say }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICES.includes(voice) ? voice : 'Kore' } } },
          },
        },
        120_000,
      )
      const a = inline(j)
      const rate = Number((a.mimeType.match(/rate=(\d+)/) ?? [])[1]) || 24000
      writeFileSync(file, wav(Buffer.from(a.data, 'base64'), rate))
      return { file, by: 'Gemini' }
    } catch (err) {
      console.log(`[jarvis] Gemini voice unavailable (${err.message}) - using the Windows voice`)
    }
  }
  const script =
    'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
    '$s.SetOutputToWaveFile($env:J_FILE); $s.Speak($env:J_TEXT); $s.Dispose()'
  await new Promise((res, rej) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, J_FILE: file, J_TEXT: say }, windowsHide: true, timeout: 120_000 },
      (err) => (err ? rej(err) : res()),
    ),
  )
  return { file, by: 'Windows' }
}

/** Veo, if this key can use it (needs billing): its model name, or null. */
async function veoModel() {
  const key = geminiKey()
  if (!key) return null
  try {
    const r = await fetch(`${GEMINI}/models?pageSize=300&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10000) })
    const ids = ((await r.json()).models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('predictLongRunning') && /veo/i.test(m.name))
      .map((m) => m.name.replace(/^models\//, ''))
    return ids.find((m) => /fast/.test(m)) ?? ids[0] ?? null
  } catch {
    return null
  }
}

/** Build a reel: one clip per scene (image + voice + subtitles + zoom), joined. */
export async function buildReel({ title, scenes, aspect = '9:16', voice = 'Kore', subtitles = true, music }) {
  if (!findTool('ffmpeg')) throw new Error('ffmpeg is not installed yet, so videos cannot be put together.')
  const [W, H] = SIZES[aspect]
  const work = join(tmpdir(), `jarvis-reel-${stamp()}`)
  mkdirSync(work, { recursive: true })
  try {
    const clips = []
    let voiceBy = ''
    for (const [i, s] of scenes.entries()) {
      const img = await makeImage(`${s.visual}. Cinematic, high detail, no text in the image.`, aspect, join(work, `s${i}.png`))
      const v = await speak(s.narration, voice, join(work, `s${i}.wav`))
      voiceBy = v.by
      const dur = Math.max(2, ((await duration(v.file)) ?? 4) + 0.6)
      const frames = Math.ceil(dur * 30)
      const vf = [
        `scale=${Math.round(W * 1.15)}:${Math.round(H * 1.15)}:force_original_aspect_ratio=increase`,
        `crop=${Math.round(W * 1.15)}:${Math.round(H * 1.15)}`,
        `zoompan=z='min(zoom+0.0007,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=30`,
      ]
      if (subtitles) {
        const tf = join(work, `s${i}.txt`)
        writeFileSync(tf, wrap(s.narration, aspect === '9:16' ? 26 : 42))
        vf.push(drawText(tf, { w: W, h: H }))
      }
      const clip = join(work, `s${i}.mp4`)
      await ffmpeg([
        '-loop', '1', '-i', img, '-i', v.file,
        '-vf', vf.join(','), '-af', 'apad=pad_dur=0.6',
        '-t', dur.toFixed(2), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', clip,
      ])
      clips.push(clip)
    }
    const list = join(work, 'list.txt')
    writeFileSync(list, clips.map((c) => `file '${c.replace(/\\/g, '/')}'`).join('\n'))
    const final = outFile(OUT.videos, title, '.mp4')
    if (music && existsSync(music)) {
      const joined = join(work, 'joined.mp4')
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined])
      await ffmpeg([
        '-i', joined, '-stream_loop', '-1', '-i', music,
        '-filter_complex', '[1:a]volume=0.18[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]',
        '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', final,
      ])
    } else {
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final])
    }
    return { file: final, seconds: await duration(final).catch(() => null), voiceBy }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Run edit steps on a video; returns the new file and what was done. */
export async function editVideo({ input, steps, name }) {
  if (!findTool('ffmpeg')) throw new Error('ffmpeg is not installed yet, so videos cannot be edited.')
  if (!existsSync(input)) throw new Error(`No video at ${input}.`)
  const work = join(tmpdir(), `jarvis-edit-${stamp()}`)
  mkdirSync(work, { recursive: true })
  let cur = input
  const done = []
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']
  try {
    for (const [i, s] of steps.entries()) {
      const next = join(work, `step${i}.mp4`)
      if (s.op === 'trim') {
        await ffmpeg(['-i', cur, ...(s.start != null ? ['-ss', String(s.start)] : []), ...(s.end != null ? ['-to', String(s.end)] : []), ...enc, next])
        done.push(`trimmed ${s.start ?? 0}-${s.end ?? 'end'} s`)
      } else if (s.op === 'speed') {
        const f = Math.min(2, Math.max(0.5, Number(s.factor) || 1))
        if (await hasAudio(cur)) {
          await ffmpeg(['-i', cur, '-filter_complex', `[0:v]setpts=PTS/${f}[v];[0:a]atempo=${f}[a]`, '-map', '[v]', '-map', '[a]', ...enc, next])
        } else {
          await ffmpeg(['-i', cur, '-vf', `setpts=PTS/${f}`, ...enc, next])
        }
        done.push(`speed x${f}`)
      } else if (s.op === 'crop') {
        const [W, H] = SIZES[s.aspect] ?? SIZES['9:16']
        await ffmpeg(['-i', cur, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`, ...enc, next])
        done.push(`cropped to ${s.aspect ?? '9:16'}`)
      } else if (s.op === 'text') {
        const tf = join(work, `t${i}.txt`)
        writeFileSync(tf, wrap(s.text ?? '', 30))
        const [w, h] = await videoSize(cur)
        let f = drawText(tf, { w, h, place: s.place })
        if (s.from != null || s.to != null) f += `:enable='between(t,${s.from ?? 0},${s.to ?? 99999})'`
        await ffmpeg(['-i', cur, '-vf', f, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', next])
        done.push(`added text "${String(s.text).slice(0, 30)}"`)
      } else if (s.op === 'mute') {
        await ffmpeg(['-i', cur, '-an', '-c:v', 'copy', next])
        done.push('muted')
      } else if (s.op === 'voiceover') {
        const audio = s.audio || (await speak(String(s.text ?? ''), s.voice ?? 'Kore', join(work, `vo${i}.wav`))).file
        if (!existsSync(audio)) throw new Error(`No audio at ${audio}`)
        if (s.mode === 'mix' && (await hasAudio(cur))) {
          await ffmpeg(['-i', cur, '-i', audio, '-filter_complex', '[0:a]volume=0.35[o];[o][1:a]amix=inputs=2:duration=first[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', next])
        } else {
          await ffmpeg(['-i', cur, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-af', 'apad', '-shortest', next])
        }
        done.push(`${s.mode === 'mix' ? 'mixed in' : 'added'} a voiceover`)
      } else if (s.op === 'music') {
        if (!s.file || !existsSync(s.file)) throw new Error(`No music file at ${s.file}`)
        const vol = Math.min(1, Math.max(0.05, Number(s.volume) || 0.2))
        await ffmpeg(
          (await hasAudio(cur))
            ? ['-i', cur, '-stream_loop', '-1', '-i', s.file, '-filter_complex', `[1:a]volume=${vol}[m];[0:a][m]amix=inputs=2:duration=first[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', next]
            : ['-i', cur, '-stream_loop', '-1', '-i', s.file, '-map', '0:v', '-map', '1:a', '-af', `volume=${vol}`, '-c:v', 'copy', '-c:a', 'aac', '-shortest', next],
        )
        done.push('added music')
      } else if (s.op === 'join') {
        const files = [cur, ...(s.files ?? [])].filter((f) => existsSync(f))
        const [w, h] = await videoSize(cur)
        const ins = files.flatMap((f) => ['-i', f])
        const parts = files.map((_, k) => `[${k}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${k}]`).join(';')
        const cat = files.map((_, k) => `[v${k}]`).join('') + `concat=n=${files.length}:v=1:a=0[v]`
        await ffmpeg([...ins, '-filter_complex', `${parts};${cat}`, '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', next])
        done.push(`joined ${files.length} clips (picture only — add a voiceover or music after)`)
      } else {
        continue
      }
      cur = next
    }
    const final = outFile(OUT.videos, name ?? `${basename(input, extname(input))} edited`, '.mp4')
    await ffmpeg(['-i', cur, '-c', 'copy', '-movflags', '+faststart', final])
    return { file: final, done }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- the tools

export function creatorServer() {
  return createSdkMcpServer({
    name: 'jarvis_creator',
    version: '1.0.0',
    instructions: 'Make websites, images, voiceovers and videos; edit videos.',
    tools: [
      tool(
        'create_website',
        'Create a website: write its files (index.html first, plus any CSS/JS) into ' +
          'Documents\\Jarvis Projects\\<name> and open it in the browser. Write complete, ' +
          'modern, responsive code — no placeholders. Call again with the same name to update it.',
        {
          name: z.string().describe('Project name, e.g. "bakery site"'),
          files: z.array(z.object({ path: z.string().describe('e.g. index.html, css/style.css'), content: z.string() })),
          open: z.boolean().optional().describe('Open index.html afterwards (default true)'),
        },
        async ({ name, files, open = true }) => {
          const root = join(OUT.sites, safeName(name, 'site'))
          mkdirSync(root, { recursive: true })
          const written = []
          for (const f of files) {
            const target = resolvePath(root, normalize(String(f.path).replace(/^[\\/]+/, '')))
            if (!target.startsWith(root + sep)) return failText(`Refused: "${f.path}" is outside the project folder.`)
            if (/\.(exe|bat|cmd|ps1|vbs|com|scr|msi)$/i.test(target)) return failText(`Refused: ${basename(target)} is a program.`)
            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, f.content)
            written.push(target.slice(root.length + 1))
          }
          const index = join(root, 'index.html')
          if (open && existsSync(index)) openFile(index)
          return text(`Website "${basename(root)}" saved (${written.join(', ')}) in Documents\\Jarvis Projects${open && existsSync(index) ? ', and opened in the browser' : ''}.`)
        },
      ),
      tool(
        'generate_image',
        'Generate an image from a description (Gemini). Saved to Pictures\\Jarvis. Describe it ' +
          'richly: subject, style, light, colours, composition.',
        {
          prompt: z.string(),
          aspect: z.enum(['1:1', '9:16', '16:9', '4:5', '3:4', '4:3']).optional(),
          name: z.string().optional(),
        },
        async ({ prompt, aspect = '1:1', name }) => {
          try {
            const f = await makeImage(prompt, aspect, outFile(OUT.pictures, name ?? `image ${stamp()}`, '.png'))
            openFile(f)
            return text(`Image saved: ${f}`)
          } catch (err) {
            return failText(`Could not make the image: ${err.message}`)
          }
        },
      ),
      tool(
        'voiceover',
        `Turn text into a spoken audio file (WAV, Music\\Jarvis). Voices: ${VOICES.join(', ')} ` +
          '(Gemini; a Windows voice is used if Gemini is unavailable). Write the text as it should be ' +
          'spoken; a short style note at the start works ("Say cheerfully: ...").',
        { text: z.string(), voice: z.string().optional(), name: z.string().optional() },
        async ({ text: say, voice = 'Kore', name }) => {
          try {
            const r = await speak(say, voice, outFile(OUT.music, name ?? `voiceover ${stamp()}`, '.wav'))
            const d = await duration(r.file).catch(() => null)
            return text(`Voiceover saved (${r.by} voice${d ? `, ${d.toFixed(1)} s` : ''}): ${r.file}`)
          } catch (err) {
            return failText(`Could not make the voiceover: ${err.message}`)
          }
        },
      ),
      tool(
        'make_reel',
        'Make a video from a script: for each scene, a generated image of `visual`, the `narration` ' +
          'voiced and shown as subtitles, with a slow zoom; scenes joined into one MP4 in Videos\\Jarvis. ' +
          '9:16 suits Reels/Shorts. Takes about 20-40 s per scene. Write short narrations (one or two ' +
          'sentences per scene) and vivid visual descriptions.',
        {
          title: z.string(),
          scenes: z.array(z.object({ narration: z.string(), visual: z.string() })).min(1).max(12),
          aspect: z.enum(['9:16', '16:9', '1:1', '4:5']).optional(),
          voice: z.string().optional(),
          subtitles: z.boolean().optional().describe('Default true'),
          music: z.string().optional().describe('Optional path to a music file, mixed in quietly'),
        },
        async (args) => {
          const t0 = Date.now()
          try {
            const r = await buildReel(args)
            openFile(r.file)
            return text(
              `Reel "${basename(r.file)}" made: ${args.scenes.length} scenes${r.seconds ? `, ${r.seconds.toFixed(0)} s` : ''}, ` +
                `${args.aspect ?? '9:16'}, ${r.voiceBy} voice, in ${Math.round((Date.now() - t0) / 1000)} s. ` +
                `Saved to ${r.file} and playing now.`,
            )
          } catch (err) {
            return failText(`The reel could not be finished: ${err.message}`)
          }
        },
      ),
      tool(
        'generate_video_clip',
        "A real AI-generated video clip from a description, with Google's Veo — only if the Gemini " +
          'key has Veo access (it needs billing enabled on the Gemini account). Without it, say so and ' +
          'offer make_reel instead.',
        { prompt: z.string(), aspect: z.enum(['9:16', '16:9']).optional(), name: z.string().optional() },
        async ({ prompt, aspect = '9:16', name }) => {
          const model = await veoModel()
          if (!model) {
            return failText(
              "This Gemini key has no access to Veo, Google's video model — it needs billing turned on in the " +
                'Gemini account. I can make the video from generated images, a voiceover and subtitles instead (make_reel).',
            )
          }
          const key = geminiKey()
          try {
            const r = await fetch(`${GEMINI}/models/${model}:predictLongRunning?key=${encodeURIComponent(key)}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ instances: [{ prompt }], parameters: { aspectRatio: aspect } }),
            })
            let op = await r.json()
            if (!r.ok) throw new Error(op.error?.message ?? `Veo ${r.status}`)
            for (let i = 0; i < 90 && !op.done; i++) {
              await new Promise((res) => setTimeout(res, 10_000))
              op = await (await fetch(`${GEMINI}/${op.name}?key=${encodeURIComponent(key)}`)).json()
            }
            if (!op.done) throw new Error('Veo took longer than 15 minutes.')
            const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
            if (!uri) throw new Error(op.error?.message ?? 'Veo returned no video.')
            const v = await fetch(`${uri}${uri.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`)
            const f = outFile(OUT.videos, name ?? `veo ${stamp()}`, '.mp4')
            writeFileSync(f, Buffer.from(await v.arrayBuffer()))
            openFile(f)
            return text(`Video clip made with ${model}: ${f}`)
          } catch (err) {
            return failText(`Veo could not make the clip: ${err.message}`)
          }
        },
      ),
      tool(
        'edit_video',
        'Edit a video with ffmpeg; steps run in order and the result is saved as a new file in ' +
          'Videos\\Jarvis (the original is kept). Steps: ' +
          'trim {start, end} (seconds) · speed {factor 0.5-2} · crop {aspect "9:16"|"16:9"|"1:1"|"4:5"} · ' +
          'text {text, place "top"|"center"|"bottom", from?, to?} · mute {} · ' +
          'voiceover {text, voice?, mode "replace"|"mix"} or {audio: path, mode} · music {file, volume?} · ' +
          'join {files: [paths]} (appended after this video).',
        {
          input: z.string().describe('The video file (full path)'),
          steps: z.array(z.object({ op: z.enum(['trim', 'speed', 'crop', 'text', 'mute', 'voiceover', 'music', 'join']) }).passthrough()),
          name: z.string().optional(),
        },
        async (args) => {
          try {
            const r = await editVideo(args)
            openFile(r.file)
            return text(`Edited (${r.done.join(', ')}). Saved as ${r.file} — the original is unchanged.`)
          } catch (err) {
            return failText(`Editing stopped: ${err.message}`)
          }
        },
      ),
    ],
  })
}

export const PROMPT_CREATOR = `Creating things — the jarvis_creator tools:
- "Make a website for …": plan it briefly, then create_website with complete,
  modern, responsive files (index.html, CSS, JS). Say what you built in a
  sentence; never read code aloud.
- "Write a script for my reel about …": write it yourself — a hook in the first
  line, short punchy scenes, a call to action — show it on screen, and save it
  with save_document if asked.
- "Make a video of this script": make_reel (images + voiceover + subtitles,
  9:16 by default). If they want a real AI video, try generate_video_clip; it
  says plainly when the key cannot. Tell them it takes a minute or two.
- "Edit the video …", "add a voiceover", "cut the first 5 seconds", "make it
  vertical": edit_video on the file (the last video you made unless they name
  one). "Give it a voiceover" with a script: the voiceover step in edit_video.
- Images: generate_image. Voice files alone: voiceover.

`
