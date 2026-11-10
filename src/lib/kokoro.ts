/**
 * Neural speech, entirely in the browser.
 *
 * `speechSynthesis` is limited to whatever voices the operating system ships,
 * and on macOS the British male option is Daniel — a compact concatenative
 * voice from over a decade ago. It is the honest ceiling of the built-in API
 * and it sounds like a satnav.
 *
 * Kokoro is an 82M-parameter TTS model that runs on WebGPU via ONNX. No cloud,
 * no API key, nothing leaves the machine — but it sounds like a person. It
 * carries four British male voices, which is what this project actually wants.
 *
 * The cost is a one-time ~86MB model download, cached by the browser
 * afterwards. It's fetched during the boot sequence so the first "Hey Jarvis"
 * isn't waiting on it, and anything that goes wrong falls back to Daniel.
 */

import { KOKORO_VOICE } from '../config'

type Kokoro = {
  generate: (
    text: string,
    opts: { voice: string; speed?: number },
  ) => Promise<{ toBlob: () => Blob }>
}

let model: Kokoro | null = null
let loading: Promise<Kokoro | null> | null = null
let failed = false

/** 0..1 while the model downloads, for the boot readout. */
let progress = 0
export const loadProgress = () => progress
export const isReady = () => model !== null
export const isUnavailable = () => failed

/** Exposed for diagnosis — the console warning alone is easy to miss. */
export let lastError = ''

/**
 * British male voices, in the order they suit the character. George is the
 * closest to a measured RP baritone; Fable is warmer, Lewis lower, Daniel
 * brighter.
 */
export const VOICES = ['bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel'] as const

/**
 * A voice id the model doesn't carry throws inside generate(), once per
 * sentence, for the life of the page — and a typo in an env var is the likeliest
 * way to get there. Check it once at module load and fall back audibly in the
 * console instead.
 */
function resolveVoice(): string {
  if ((VOICES as readonly string[]).includes(KOKORO_VOICE)) return KOKORO_VOICE
  console.warn(
    `[jarvis] VITE_KOKORO_VOICE="${KOKORO_VOICE}" is not one of ${VOICES.join(', ')} — using ${VOICES[0]}.`,
  )
  return VOICES[0]
}

const VOICE_KEY = 'jarvis.kokoroVoice'

const SPEED = (() => {
  const v = Number(String(import.meta.env.VITE_VOICE_SPEED ?? '').trim())
  return Number.isFinite(v) && v >= 0.6 && v <= 1.5 ? v : 1.05
})()

/** The configured voice, unless V has picked another one on this machine. */
let voice: string = (() => {
  try {
    const saved = localStorage.getItem(VOICE_KEY)
    if (saved && (VOICES as readonly string[]).includes(saved)) return saved
  } catch {
    /* storage unavailable */
  }
  return resolveVoice()
})()

/** The neural voice in use, e.g. "george". */
export function currentVoice(): string {
  return voice.replace(/^b[mf]_/, '')
}

/** Step to the next British voice and remember it. Returns its short name. */
export function cycleVoice(): string {
  const i = (VOICES as readonly string[]).indexOf(voice)
  voice = VOICES[(i + 1) % VOICES.length]
  try {
    localStorage.setItem(VOICE_KEY, voice)
  } catch {
    /* storage unavailable */
  }
  return currentVoice()
}

/**
 * Model precision on the GPU: fp32.
 *
 * q8 is slow on WebGPU (seven to twelve seconds a sentence, measured). fp16
 * looked ideal — same speed, about 375MB less RAM — but on an RTX 40-series
 * laptop it produced NaN for most samples: the voice "played" and was
 * completely silent. fp32 is the one that is both fast and correct.
 * VITE_KOKORO_DTYPE overrides it; window.__kokoroDtype exists for testing.
 */
type GpuDtype = 'fp32' | 'fp16' | 'q8' | 'q4'
const GPU_DTYPE: GpuDtype = ((globalThis as { __kokoroDtype?: string }).__kokoroDtype ??
  (String(import.meta.env.VITE_KOKORO_DTYPE ?? '').trim() || 'fp32')) as GpuDtype

/**
 * Generation failures latch after this many in a row. One is worth retrying —
 * a WebGPU device can be lost and recovered — but a run of them means the
 * engine is not going to work on this machine, and it is better to drop to the
 * system voice for good than to alternate between the two mid-conversation.
 */
const MAX_FAILURES = 3
let failures = 0

export async function load(): Promise<Kokoro | null> {
  if (model) return model
  if (failed) return null
  if (loading) return loading

  loading = (async () => {
    try {
      // Serve the ONNX runtime from our own origin (scripts/start.mjs copies it
      // to public/ort). Left to itself transformers.js imports it from a CDN,
      // the page CSP blocks that, and the voice silently drops to the system
      // one — which is exactly what used to happen.
      //
      // The loader is handed over as a blob: URL rather than '/ort/…' because
      // the runtime import()s it, and the Vite dev server refuses JavaScript
      // imports of files in /public. Fetching it as text and wrapping it is
      // allowed (script-src includes blob:), and the .wasm beside it is a
      // plain fetch, which Vite serves happily.
      const { env } = await import('@huggingface/transformers')
      if (env.backends.onnx.wasm) {
        const base = new URL('/ort/', location.href).href
        const res = await fetch(`${base}ort-wasm-simd-threaded.jsep.mjs`)
        if (!res.ok) throw new Error(`voice runtime missing (${res.status}) — restart with npm start`)
        const mjs = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }))
        env.backends.onnx.wasm.wasmPaths = { mjs, wasm: `${base}ort-wasm-simd-threaded.jsep.wasm` }
      }

      const { KokoroTTS } = await import('kokoro-js')
      const open = (device: 'webgpu' | 'wasm') =>
        KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
          // fp32 on the GPU, q8 on the CPU. Quantised weights are slow on
          // WebGPU — measured on an RTX 40-series laptop, q8 took seven to
          // twelve seconds a sentence, far too slow to converse with — while
          // fp32 is what kokoro-js recommends there. It is a larger one-off
          // download (about 330MB against 86MB), cached after the first run.
          dtype: device === 'webgpu' ? GPU_DTYPE : 'q8',
          device,
          // The callback is a union across several event shapes; only the
          // download-progress one carries a percentage.
          progress_callback: (p: unknown) => {
            const pct = (p as { progress?: number })?.progress
            if (typeof pct === 'number') progress = pct / 100
          },
        })
      // WebGPU keeps generation well ahead of playback. Without it the CPU
      // path is slower but still a real voice, which beats the system one.
      let tts
      try {
        tts = await open('webgpu')
      } catch (gpuErr) {
        console.warn('[jarvis] kokoro: WebGPU unavailable, using the CPU:', gpuErr)
        tts = await open('wasm')
      }
      // One silent sentence while the boot screen is still up. The first
      // generation on WebGPU compiles its shaders and takes several seconds;
      // paying that here means the first real answer is not the slow one.
      try {
        const probe = (await (tts as unknown as Kokoro).generate('Systems online, sir.', {
          voice,
          speed: SPEED,
        })) as unknown as { audio?: Float32Array }
        // Also a sanity check. A model that returns NaN plays as perfect
        // silence while reporting success — exactly how fp16 failed — so an
        // unusable result falls back to the system voice instead of muting him.
        const s = probe?.audio
        if (s && s.length) {
          let bad = 0
          for (let i = 0; i < s.length; i += 50) if (!Number.isFinite(s[i])) bad++
          if (bad > s.length / 50 / 4) {
            throw new Error(`the ${GPU_DTYPE} model produced invalid audio on this GPU`)
          }
        }
      } catch (err) {
        if (String((err as Error)?.message ?? '').includes('invalid audio')) throw err
        /* any other warm-up failure is not a failed voice — speak() will report */
      }
      progress = 1
      model = tts as unknown as Kokoro
      return model
    } catch (err) {
      console.warn('[jarvis] kokoro unavailable, using the system voice:', err)
      lastError = String((err as Error)?.message ?? err)
      failed = true
      return null
    } finally {
      loading = null
    }
  })()

  return loading
}

/** Synthesise one sentence. Returns null if the model isn't usable. */
export async function speak(text: string): Promise<string | null> {
  const tts = await load()
  if (!tts) return null
  try {
    const audio = await tts.generate(text, {
      voice,
      // Crisp, a touch brisk: a capable assistant rather than a narrator.
      // VITE_VOICE_SPEED overrides it (0.8 slower … 1.3 faster).
      speed: SPEED,
    })
    failures = 0
    return URL.createObjectURL(audio.toBlob())
  } catch (err) {
    // Surfaced rather than swallowed: a silent null here just looks like the
    // voice quietly reverting to the system one with no explanation.
    console.error('[jarvis] kokoro generation failed:', err)
    lastError = String((err as Error)?.message ?? err)
    failures++
    if (failures >= MAX_FAILURES) {
      // Nothing else sets this on the generation path, so without it tts.ts
      // keeps routing every sentence here and every sentence keeps throwing.
      failed = true
      console.warn(
        `[jarvis] kokoro failed ${failures} times running — the system voice from here on.`,
      )
    }
    return null
  }
}

/** Voice ids this build of the model actually carries. */
export async function availableVoices(): Promise<string[]> {
  const tts = (await load()) as unknown as { voices?: Record<string, unknown> } | null
  return tts?.voices ? Object.keys(tts.voices) : []
}
