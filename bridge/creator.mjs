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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import {
  FLOW_VOICES,
  ImageLimitError,
  VideoLimitError,
  chatgptImage,
  flowSetVoice,
  pickVoice,
  takenVoices,
  voiceLine,
  flowAddCharacter,
  flowCharacterList,
  flowCredits,
  flowRememberTextCharacter,
  chatgptSignIn,
  openGeminiLogin,
  planVideo,
} from './geminiweb.mjs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path'
import { readKeys } from './brain.mjs'

export const CREATOR_WRITE_TOOLS = new Set([
  'create_website', 'generate_image', 'voiceover', 'make_reel', 'generate_video_clip', 'edit_video', 'create_story_characters',
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

// ------------------------------------------------------------- story characters
//
// A story's characters: a reference picture of each from the user's ChatGPT,
// uploaded to Google Flow as a named character, so every scene shows the same
// faces. Pictures are kept in Pictures\Jarvis\Characters.

const CHARACTERS_DIR = join(OUT.pictures, 'Characters')
const lower = (s) => String(s).trim().toLowerCase()
/** A story character's saved details (description, voice …), by name. */
const castInfo = (name) => flowCharacterList().find((c) => lower(c.name) === lower(name)) ?? null

/** A child (by the description), for whom Flow won't take a realistic photo. */
const isChild = (d) => /\b(\d|1[0-7])[- ]?(year|yr)s?[- ]?old\b|\b(child|kid|boy|girl|baby|toddler|teen(ager)?|schoolboy|schoolgirl|son|daughter)\b/i.test(d) && !/\b(man|woman|adult|grown)\b/i.test(d)

/** One character: ChatGPT draws the reference, Flow gets it with the name and description. */
async function makeCharacter({ name, description, voice }, style) {
  // Its own voice: the one asked for, or one that suits it and no other
  // character already has.
  voice = voice && FLOW_VOICES[voice] ? voice : pickVoice(description, takenVoices())
  // Google Flow refuses realistic photos of children as characters, so a
  // child is drawn in an animated style unless another was asked for.
  style ??= isChild(description) ? 'Pixar-style 3D animated character, soft cinematic lighting' : 'photorealistic, cinematic lighting'
  if (isChild(description) && /photo|realistic|real life/i.test(style)) style = 'Pixar-style 3D animated character, soft cinematic lighting'
  const file = outFile(CHARACTERS_DIR, name, '.png')
  await chatgptImage(
    `Create a character reference image of ${name}: ${description}. Full body, front view, neutral standing pose, ` +
      `plain white background, ${style}. Only this one character, no text, labels or watermark.`,
    file,
  )
  // Children: Flow refuses to animate them from a picture (even a cartoon), so
  // they are kept in words and described in every scene instead.
  if (isChild(description)) flowRememberTextCharacter({ name, description: `${description}; ${style}`, image: file, voice })
  else await flowAddCharacter({ name, description, image: file, voice })
  return file
}

/**
 * Make sure every named character is in Flow before any scene is generated:
 * the ones missing are made from `cast` (name + description). Throws if a
 * character is missing and has no description to make it from.
 */
async function ensureCharacters(names, cast = [], style) {
  const have = new Set(flowCharacterList().map((c) => lower(c.name)))
  const made = []
  const missing = []
  for (const n of [...new Set(names.map((x) => String(x).trim()).filter(Boolean))]) {
    if (have.has(lower(n))) continue
    const c = cast.find((x) => lower(x.name) === lower(n))
    if (!c?.description) {
      missing.push(n)
      continue
    }
    await makeCharacter(c, style)
    have.add(lower(n))
    made.push(n)
  }
  if (missing.length) {
    throw new Error(
      `${missing.join(', ')} ${missing.length > 1 ? "aren't" : "isn't"} in Google Flow yet, and there's no description to make ` +
        `${missing.length > 1 ? 'them' : 'it'} from. Describe ${missing.length > 1 ? 'them' : 'it'} (create_story_characters) first.`,
    )
  }
  return made
}
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
/** Tamil script; subtitles in it need a font that has it (Nirmala UI, on every Windows 10/11). */
const TAMIL = /[\u0B80-\u0BFF]/
const TAMIL_FONT = existsSync('C:/Windows/Fonts/Nirmala.ttc') ? 'C:/Windows/Fonts/Nirmala.ttc' : existsSync('C:/Windows/Fonts/latha.ttf') ? 'C:/Windows/Fonts/latha.ttf' : FONT

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
  // Tamil text gets a Tamil font (ffmpeg's HarfBuzz shaping joins the letters).
  let font = FONT
  try {
    if (TAMIL.test(readFileSync(file, 'utf8'))) font = TAMIL_FONT
  } catch {
    /* no file yet: the default font */
  }
  return (
    `drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(file)}':fontcolor=white:fontsize=${fs}` +
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
/**
 * Tamil voices: Microsoft's neural voices through edge-tts (free, no key; in
 * the wake listener's Python). Tamil text with any other voice uses Pallavi.
 */
const TAMIL_VOICES = {
  Pallavi: 'ta-IN-PallaviNeural',
  Valluvar: 'ta-IN-ValluvarNeural',
  Saranya: 'ta-LK-SaranyaNeural',
  Kumar: 'ta-LK-KumarNeural',
}
const EDGE_TTS = join(homedir(), '.jarvis', 'wake-venv', 'Scripts', 'edge-tts.exe')
// Gemini's speech has the same 30 voices as Flow's characters.
const GEMINI_VOICES = Object.keys(FLOW_VOICES)
export const VOICES = [...GEMINI_VOICES, ...Object.keys(TAMIL_VOICES)]

/** Tamil speech with edge-tts, to a WAV; null if it isn't available. */
async function speakTamil(say, voice, file) {
  if (!existsSync(EDGE_TTS)) return null
  const id = TAMIL_VOICES[voice] ?? (/valluvar|male|man|ஆண்/i.test(String(voice)) ? TAMIL_VOICES.Valluvar : TAMIL_VOICES.Pallavi)
  const txt = `${file}.txt`
  const mp3 = `${file}.mp3`
  writeFileSync(txt, say)
  try {
    await new Promise((res, rej) =>
      execFile(EDGE_TTS, ['--voice', id, '--file', txt, '--write-media', mp3], { windowsHide: true, timeout: 180_000 }, (err) => (err ? rej(err) : res())),
    )
    await ffmpeg(['-i', mp3, '-ar', '24000', '-ac', '1', file])
    return { file, by: `Tamil (${Object.keys(TAMIL_VOICES).find((k) => TAMIL_VOICES[k] === id)})` }
  } catch (err) {
    console.log(`[jarvis] Tamil voice failed (${String(err.message).slice(0, 120)})`)
    return null
  } finally {
    rmSync(txt, { force: true })
    rmSync(mp3, { force: true })
  }
}

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
  // Tamil: a Tamil voice was asked for, or the text is in Tamil script.
  if (TAMIL_VOICES[voice] || TAMIL.test(say)) {
    const t = await speakTamil(say, voice, file)
    if (t) return t
  }
  if (geminiKey()) {
    try {
      const { j } = await firstOf(
        TTS_MODELS,
        {
          contents: [{ parts: [{ text: say }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICES.includes(voice) ? voice : 'Kore' } } },
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

/**
 * Build a reel: one clip per scene, joined. motion 'ai' (default): a real
 * animated Veo clip per scene through the user's Gemini plan, with the voice
 * over Veo's own sound (kept low) and subtitles; when the plan's daily limit
 * is reached, or Gemini isn't available, the remaining scenes fall back to
 * 'still': a generated picture with a slow zoom.
 */
export async function buildReel({ title, scenes, aspect = '9:16', voice = 'Kore', subtitles = true, music, motion = 'ai', cast = [], style }) {
  if (!findTool('ffmpeg')) throw new Error('ffmpeg is not installed yet, so videos cannot be put together.')
  // Every character any scene uses must be in Flow before the first scene is
  // made (the missing ones are drawn in ChatGPT and uploaded now).
  let madeCharacters = []
  if (motion === 'ai') madeCharacters = await ensureCharacters(scenes.flatMap((s) => s.characters ?? []), cast, style)
  const [W, H] = SIZES[aspect]
  const work = join(tmpdir(), `jarvis-reel-${stamp()}`)
  mkdirSync(work, { recursive: true })
  try {
    const clips = []
    let voiceBy = ''
    let aiOff = motion !== 'ai'
    let aiClips = 0
    let aiFails = 0
    let aiNote = ''
    for (const [i, s] of scenes.entries()) {
      // A voice only where the scene has narration; cinematic scenes run on
      // the AI clip's own sound and music.
      // Dialogue: characters speaking on screen, lips in sync (made by Flow
      // itself). A scene with dialogue gets no voiceover over it.
      const lines = (s.dialogue ?? []).filter((l) => String(l.line ?? '').trim())
      const said = lines.length ? '' : String(s.narration ?? '').trim()
      let voiceFile = null
      if (said) {
        const v = await speak(said, voice, join(work, `s${i}.wav`))
        voiceBy = v.by
        voiceFile = v.file
      }
      let dur = voiceFile ? Math.max(2, ((await duration(voiceFile)) ?? 4) + 0.6) : 4.5
      const clip = join(work, `s${i}.mp4`)

      // Text drawn on the scene: the narration as subtitles (bottom), and/or a
      // short on-screen caption (top), like trending reels.
      const overlays = []
      const subText = lines.length ? lines.map((l) => `${l.character}: ${l.line}`).join('\n') : said
      if (subText && subtitles) {
        const tf = join(work, `s${i}.txt`)
        const width = (aspect === '9:16' ? 26 : 42) * (TAMIL.test(subText) ? 0.8 : 1)
        writeFileSync(tf, subText.split('\n').map((x) => wrap(x, Math.round(width))).join('\n'))
        overlays.push(drawText(tf, { w: W, h: H }))
      }
      if (s.text) {
        const tf = join(work, `s${i}-top.txt`)
        writeFileSync(tf, wrap(String(s.text), aspect === '9:16' ? 20 : 34))
        overlays.push(drawText(tf, { w: W, h: H, place: 'top', size: Math.round(Math.min(W, H) / 13) }))
      }

      // Real motion: a Veo clip of the scene.
      let moving = null
      if (!aiOff) {
        try {
          const r = await planVideo(
            `${s.visual}. ${style || 'Photorealistic, cinematic lighting'}, realistic natural motion, smooth camera movement. ` +
              (lines.length
                ? `Spoken dialogue, said aloud clearly with lips moving in sync with the words: ${lines
                    .map((l) => {
                      // Each speaker in their own voice, described every time.
                      const v = voiceLine(castInfo(l.character))
                      return `${l.character}${v ? ` (in ${v})` : ''} says${l.language ? ` in ${l.language}` : ''}: "${String(l.line).trim()}"`
                    })
                    .join(' Then ')}. Natural voices, soft ambient sound under the voices, no music over the dialogue, no other speech. `
                : `${said ? 'Ambient sound only, no dialogue.' : 'A fitting cinematic soundtrack with ambient sound, no dialogue.'} `) +
              'No text, captions, subtitles or watermarks in the video.',
            { aspect: aspect === '16:9' ? '16:9' : '9:16', out: join(work, `s${i}-ai.mp4`), characters: s.characters ?? [] },
          )
          moving = r.file
          aiClips++
          aiFails = 0
        } catch (err) {
          aiNote = err instanceof VideoLimitError ? "today's Gemini videos and this month's Flow credits are used up" : String(err.message).split('\n')[0].slice(0, 160)
          // The limit and sign-in won't fix themselves mid-reel; anything else
          // gets another go on the next scene, unless it fails twice running.
          aiFails++
          if (err instanceof VideoLimitError || /signed in|not installed/i.test(err.message) || aiFails >= 2) aiOff = true
          console.log(`[jarvis] AI video for scene ${i + 1} failed (${aiNote}) - using a still`)
        }
      }

      const enc = ['-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2']
      if (moving) {
        // The scene runs the whole AI clip (up to 10 s), or longer if the narration needs it.
        dur = Math.max(voiceFile ? dur : 0, Math.min(10, (await duration(moving).catch(() => null)) ?? 5))
        const vf = [
          `scale=${W}:${H}:force_original_aspect_ratio=increase`,
          `crop=${W}:${H}`,
          // Narration longer than the clip: hold its last frame.
          `tpad=stop_mode=clone:stop_duration=${Math.ceil(dur)}`,
          'fps=30',
          ...overlays,
        ]
        const own = await hasAudio(moving)
        const inputs = ['-i', moving]
        let audio
        if (voiceFile) {
          inputs.push('-i', voiceFile)
          audio = own ? '[0:a]volume=0.22,apad[bg];[1:a]apad[vo];[bg][vo]amix=inputs=2:duration=longest:normalize=0[a]' : '[1:a]apad[a]'
        } else {
          // No narration: the clip's own sound, full volume (silence if it has none).
          inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
          audio = own ? '[0:a]apad[a]' : '[1:a]anull[a]'
        }
        await ffmpeg([...inputs, '-filter_complex', `[0:v]${vf.join(',')}[v];${audio}`, '-map', '[v]', '-map', '[a]', '-t', dur.toFixed(2), ...enc, clip])
        clips.push(clip)
        continue
      }

      // A picture can't speak: its dialogue is read out by the voice instead.
      if (lines.length && !voiceFile) {
        // Each line in its speaker's own voice, joined in order.
        const parts = []
        for (const [k, l] of lines.entries()) {
          const c = castInfo(l.character)
          const tamil = TAMIL.test(l.line)
          const female = /^Female/.test(FLOW_VOICES[c?.voice] ?? '')
          const v = await speak(String(l.line).trim(), tamil ? (female ? 'Pallavi' : 'Valluvar') : c?.voice || voice, join(work, `s${i}-l${k}.wav`))
          voiceBy = v.by
          parts.push(v.file)
        }
        voiceFile = join(work, `s${i}.wav`)
        if (parts.length === 1) copyFileSync(parts[0], voiceFile)
        else await ffmpeg([...parts.flatMap((p) => ['-i', p]), '-filter_complex', `${parts.map((_, k) => `[${k}:a]`).join('')}concat=n=${parts.length}:v=0:a=1[a]`, '-map', '[a]', voiceFile])
        dur = Math.max(2, ((await duration(voiceFile)) ?? 4) + 0.6)
      }
      const img = await makeImage(`${s.visual}. Cinematic, high detail, no text in the image.`, aspect, join(work, `s${i}.png`))
      const frames = Math.ceil(dur * 30)
      const vf = [
        `scale=${Math.round(W * 1.15)}:${Math.round(H * 1.15)}:force_original_aspect_ratio=increase`,
        `crop=${Math.round(W * 1.15)}:${Math.round(H * 1.15)}`,
        `zoompan=z='min(zoom+0.0007,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=30`,
        ...overlays,
      ]
      await ffmpeg([
        '-loop', '1', '-i', img,
        ...(voiceFile ? ['-i', voiceFile] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']),
        '-vf', vf.join(','), '-af', 'apad=pad_dur=0.6', '-map', '0:v', '-map', '1:a',
        '-t', dur.toFixed(2), ...enc, clip,
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
    return { file: final, seconds: await duration(final).catch(() => null), voiceBy, aiClips, aiNote, madeCharacters }
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
        'Make a video from a script, scenes joined into one MP4 in Videos\\Jarvis, each scene\'s ' +
          '`narration` voiced and shown as subtitles. motion "ai" (default): each scene is a REAL ' +
          'animated AI video of `visual` made with GOOGLE FLOW (about 12 credits and 1-2 minutes per ' +
          'scene; the Gemini app if Flow can\'t); when both are used up, the rest become "still" scenes (a ' +
          'generated picture with a slow zoom, ~20 s each). 9:16 suits Reels/Shorts. Write short ' +
          'narrations (one or two sentences per scene) and vivid, concrete visual descriptions of the ' +
          'action and camera movement.',
        {
          title: z.string(),
          scenes: z
            .array(
              z.object({
                visual: z.string().describe('The moving shot: subject (fully described, same words every scene for a recurring character), action, setting, light, camera move'),
                narration: z.string().optional().describe('Voiceover for the scene; leave out for a cinematic reel that runs on the video\'s own music and sound'),
                dialogue: z
                  .array(z.object({ character: z.string(), line: z.string(), language: z.string().optional() }))
                  .optional()
                  .describe('Lines characters SAY on screen, lip-synced by Flow (short: about 4 s of speech per clip); replaces narration for the scene'),
                text: z.string().optional().describe('A short on-screen caption at the top (2-6 words)'),
                characters: z.array(z.string()).optional().describe('Names of the story characters in this scene/page; each is attached in Flow before the scene is generated'),
              }),
            )
            .min(1)
            .max(12),
          cast: z
            .array(z.object({ name: z.string(), description: z.string() }))
            .optional()
            .describe('Descriptions of the characters (look, age, clothes, style) — any not yet in Flow are drawn in ChatGPT and uploaded before the first scene'),
          style: z.string().optional().describe('Look of the character pictures, e.g. "photorealistic", "Pixar-style 3D animation", "anime"'),
          aspect: z.enum(['9:16', '16:9', '1:1', '4:5']).optional(),
          voice: z.string().optional(),
          subtitles: z.boolean().optional().describe('Default true'),
          music: z.string().optional().describe('Optional path to a music file, mixed in quietly'),
          motion: z.enum(['ai', 'still']).optional().describe('ai (default): real animated AI video per scene; still: pictures with a slow zoom'),
        },
        async (args) => {
          const t0 = Date.now()
          try {
            const r = await buildReel(args)
            openFile(r.file)
            const kind =
              r.aiClips === args.scenes.length
                ? 'all scenes animated with AI video'
                : r.aiClips
                  ? `${r.aiClips} of ${args.scenes.length} scenes animated with AI video, the rest as pictures (${r.aiNote})`
                  : args.motion === 'still'
                    ? 'pictures with a slow zoom'
                    : `pictures with a slow zoom — no AI video (${r.aiNote || 'not available'})`
            return text(
              (r.madeCharacters?.length ? `New characters made in ChatGPT and added to Flow first: ${r.madeCharacters.join(', ')}. ` : '') +
              `Reel "${basename(r.file)}" made: ${args.scenes.length} scenes${r.seconds ? `, ${r.seconds.toFixed(0)} s` : ''}, ` +
                `${args.aspect ?? '9:16'}, ${kind}, ${r.voiceBy ? `${r.voiceBy} voice` : "no voiceover (the video's own sound)"}, in ${Math.round((Date.now() - t0) / 1000)} s. ` +
                `Saved to ${r.file} and playing now.`,
            )
          } catch (err) {
            return failText(`The reel could not be finished: ${err.message}`)
          }
        },
      ),
      tool(
        'generate_video_clip',
        'One real AI-generated video clip (about 4-10 s, with sound) from a description, made with ' +
          "GOOGLE FLOW in JARVIS's window (the user's choice for every video; about 12 credits a clip), " +
          "falling back to the Gemini app's daily videos only if Flow can't. 1-6 minutes. Describe the " +
          'subject, action, setting, mood and camera movement.',
        {
          prompt: z.string(),
          aspect: z.enum(['9:16', '16:9']).optional(),
          name: z.string().optional(),
          characters: z.array(z.string()).optional().describe('Story characters in the clip (attached in Flow first)'),
          cast: z.array(z.object({ name: z.string(), description: z.string() })).optional().describe('Descriptions for characters not yet in Flow'),
        },
        async ({ prompt, aspect = '9:16', name, characters = [], cast = [] }) => {
          // Google Flow first, always (then the Gemini app); the API's Veo only
          // if both fail and the key happens to have it.
          const f = outFile(OUT.videos, name ?? `ai video ${stamp()}`, '.mp4')
          let planErr
          try {
            if (characters.length) await ensureCharacters(characters, cast)
            const r = await planVideo(prompt, { aspect, out: f, characters })
            openFile(f)
            return text(`AI video made with ${r.by === 'Flow' ? 'Google Flow' : 'the Gemini app (Flow was unavailable)'} in ${r.seconds} s: ${f} (playing now).`)
          } catch (err) {
            planErr = err
          }
          const model = await veoModel()
          if (!model) {
            if (planErr instanceof VideoLimitError) {
              return failText(`${planErr.message} I can make it as pictures with motion instead (make_reel, motion "still").`)
            }
            return failText(`Couldn't make the AI video with Google Flow: ${String(planErr.message).split('\n')[0]}`)
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
        'gemini_login',
        "Open JARVIS's Gemini window so the user can sign in to their Google account (once) — needed " +
          'for AI videos through their Gemini plan. They type the password themselves.',
        {},
        async () => {
          try {
            await openGeminiLogin()
            return text("Gemini's sign-in window is open. Once they're signed in, AI videos will work.")
          } catch (err) {
            return failText(`Couldn't open the Gemini window: ${err.message}`)
          }
        },
      ),
      tool(
        'create_story_characters',
        "Make a story's characters before its video: for each, a character reference picture is drawn " +
          "in the user's ChatGPT (JARVIS's window) and uploaded to Google Flow as a named character, so " +
          'every scene shows the same faces. About 20-40 s per character. Characters already in Flow are ' +
          'skipped unless remake is true. Describe each fully: age, face, hair, skin, build, clothes, style.',
        {
          characters: z
            .array(
              z.object({
                name: z.string(),
                description: z.string(),
                voice: z.string().optional().describe(`Their own voice, one of: ${Object.entries(FLOW_VOICES).map(([n, v]) => `${n} (${v})`).join('; ')}. Left out: one that suits them and no other character has is picked`),
              }),
            )
            .min(1)
            .max(12),
          style: z.string().optional().describe('e.g. "photorealistic", "Pixar-style 3D animation", "anime", "claymation"'),
          remake: z.boolean().optional(),
        },
        async ({ characters, style, remake = false }) => {
          const have = new Set(flowCharacterList().map((c) => lower(c.name)))
          const done = []
          const skipped = []
          for (const c of characters) {
            if (!remake && have.has(lower(c.name))) {
              skipped.push(c.name)
              continue
            }
            try {
              const file = await makeCharacter(c, style)
              done.push(`${c.name} (${basename(file)})`)
            } catch (err) {
              const why = err instanceof ImageLimitError ? "ChatGPT's picture limit is reached for now" : String(err.message).split('\n')[0]
              return failText(
                `${done.length ? `Made and added to Flow: ${done.join(', ')}. ` : ''}Stopped at ${c.name}: ${why}.`,
              )
            }
          }
          return text(
            `${done.length ? `Made in ChatGPT: ${done.join(', ')} (pictures in ${CHARACTERS_DIR}). Adults are added to Google Flow as characters; children are kept as written descriptions used in every scene, because Flow won't animate children from a picture.` : ''}` +
              `${skipped.length ? ` Already in Flow: ${skipped.join(', ')}.` : ''}`,
          )
        },
      ),
      tool(
        'list_story_characters',
        'The story characters JARVIS has made in Google Flow (name and description).',
        {},
        async () => {
          const list = flowCharacterList()
          return text(
            list.length
              ? list
                  .map(
                    (c) =>
                      `- ${c.name}${c.textOnly ? ' (a child: described in words in each scene, as Flow won\'t animate children from a picture)' : ' (a Flow character)'}` +
                      `${c.voice ? `, voice ${c.voice} (${FLOW_VOICES[c.voice] ?? '?'})` : ', no voice yet'}: ${c.description}`,
                  )
                  .join('\n')
              : 'No story characters yet.',
          )
        },
      ),
      tool(
        'set_character_voice',
        "Give a story character their own voice (set on their Google Flow character), or change it. No two characters should share a voice.",
        { name: z.string(), voice: z.enum(Object.keys(FLOW_VOICES)).describe(Object.entries(FLOW_VOICES).map(([n, v]) => `${n}: ${v}`).join('; ')) },
        async ({ name, voice }) => {
          const other = flowCharacterList().find((c) => c.voice === voice && lower(c.name) !== lower(name))
          try {
            await flowSetVoice(name, voice)
            return text(`${name} now speaks with ${voice} (${FLOW_VOICES[voice]}).${other ? ` Note: ${other.name} has that voice too.` : ''}`)
          } catch (err) {
            return failText(`Couldn't set the voice: ${err.message}`)
          }
        },
      ),
      tool(
        'chatgpt_login',
        "Open ChatGPT in JARVIS's window so the user can sign in once (needed for character pictures). Google asks which account; they sign in themselves. Waits up to 5 minutes for it.",
        {},
        async () => {
          try {
            const ok = await chatgptSignIn()
            return ok ? text('Signed in to ChatGPT in my window.') : failText('No ChatGPT sign-in within 5 minutes; it can be tried again.')
          } catch (err) {
            return failText(`Couldn't open ChatGPT: ${err.message}`)
          }
        },
      ),
      tool(
        'video_credits',
        "How many Google Flow credits are left for AI videos this month (about 12 a clip), and when they reset.",
        {},
        async () => {
          const c = await flowCredits()
          return c
            ? text(`${c.credits} Google Flow credits left (about ${Math.floor(c.credits / 12)} AI clips), resetting ${c.resets}. The Gemini app also gives a couple of free videos a day.`)
            : failText("Couldn't read the Flow credits (the Gemini window isn't open or isn't signed in).")
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
- "Make a video / reel of this script": make_reel. By default every scene is a
  REAL animated AI video (Veo, through their Gemini plan), voiced and
  subtitled — like trending AI reels. Keep it to 3-4 scenes of about 8 seconds
  (the plan allows only a few videos a day; past the limit the rest become
  pictures with motion), and write each visual as a moving shot: subject,
  action, setting, light, camera move. Tell them it takes a few minutes and
  say plainly if some scenes came out as pictures, and why. motion "still"
  only when they want it quick or the limit is used up.
- Trending AI reels (animals or characters in suits, luxury, "boss" vibes,
  fantasy) are CINEMATIC: no narration — leave narration out so the video's
  own music and sound carry it — with at most a 2-6 word on-screen \`text\`
  per scene. Make them photorealistic and keep every recurring character
  IDENTICAL across scenes by repeating the same full description word for
  word in each visual (e.g. "a majestic white lion with a thick flowing mane,
  wearing a cream three-piece suit and gold aviator sunglasses"). Vary the
  shots: a wide establishing shot, a medium action shot, a dramatic close-up.
  Add narration only when they ask for a voiceover or a story.
- "Generate a video …" — ANY video request — is made with GOOGLE FLOW (their
  choice): generate_video_clip for one clip, make_reel for several scenes;
  both use Flow first, and the Gemini app only if Flow can't. Never answer
  a video request with pictures unless Flow and Gemini are both unavailable
  (say so). Flow costs about 12 credits a clip; video_credits says how many
  are left.
- If AI video says they aren't signed in: gemini_login, then they sign in once.
- STORIES WITH CHARACTERS (consistent faces across scenes):
  * "Generate the characters for this story": list every character with a full
    visual description (age, face, hair, skin, build, clothes; and the style —
    photorealistic, Pixar-style 3D, anime …) and call create_story_characters.
    Each is drawn in their ChatGPT and uploaded to Google Flow as a character.
  * "Give me the video prompts": write them CHARACTER-WISE — one prompt per
    scene, naming exactly which characters appear and what each one does,
    using the same names as in Flow.
  * A script to make "page-wise" / "slide-wise" / scene by scene: each page or
    slide is one scene in make_reel; put the names of EVERY character on that
    page in its \`characters\` (they are attached in Flow before that scene is
    generated), and pass the descriptions in \`cast\` so any character not yet
    in Flow is made first. Never leave a character out of a scene's list.
  * Characters TALKING on screen (lip sync): put their lines in the scene's
    \`dialogue\` ({character, line}) — Flow makes them say it with matching
    lips. Keep each scene's speech short (Flow clips are about 4 seconds:
    one or two short sentences). Don't also give narration for that scene.
  * Every character has their OWN voice (picked to suit them when made, never
    shared; set_character_voice changes it). Their lines are always spoken
    in it, in Flow and in any voiceover.
  * list_story_characters shows who is already in Flow. If ChatGPT isn't
    signed in: chatgpt_login.
- "Edit the video …", "add a voiceover", "cut the first 5 seconds", "make it
  vertical": edit_video on the file (the last video you made unless they name
  one). "Give it a voiceover" with a script: the voiceover step in edit_video.
- Images: generate_image. Voice files alone: voiceover.
- Tamil voiceover ("in Tamil", "Tamil voice", "தமிழில்"): write the narration
  itself in natural, spoken Tamil script (not English, not transliteration)
  and use voice Pallavi (female, default) or Valluvar (male); Saranya and Kumar
  are Sri Lankan Tamil. Subtitles then come out in Tamil too. Visual
  descriptions for the images stay in English.

`
