/**
 * Measuring a voice recording, so JARVIS can match its style with one of the
 * installed voices (bridge/customize.mjs → voice_analyze).
 *
 * Done here rather than in the bridge because the browser decodes every common
 * format (mp3, m4a, ogg, wav, webm, flac) with no extra software. What comes
 * out is a handful of numbers — pitch, pace, range, pauses — not a model of
 * the voice: nothing here can reproduce the person who recorded it.
 */

const RATE = 16000
const MAX_SECONDS = 90

export type VoiceFeatures = {
  durationSec: number
  speechSec: number
  medianPitchHz: number | null
  pitchRangeSemitones: number | null
  syllablesPerSec: number | null
  pauseRatio: number
  register: string
}

export type VoiceSuggestion = { gender: 'male' | 'female' | 'unclear'; rate: number; pitch: number }

const median = (xs: number[]) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))]
}

export async function analyseVoice(base64: string): Promise<{ features: VoiceFeatures; suggestion: VoiceSuggestion }> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  // An offline context at 16 kHz resamples on decode: plenty for pitch.
  const ctx = new OfflineAudioContext(1, RATE, RATE)
  const buf = await ctx.decodeAudioData(bytes.buffer)
  const n = Math.min(buf.length, RATE * MAX_SECONDS)
  const x = new Float32Array(n)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c)
    for (let i = 0; i < n; i++) x[i] += ch[i] / buf.numberOfChannels
  }

  // 40 ms frames every 10 ms.
  const FRAME = 640
  const HOP = 160
  const frames = Math.max(0, Math.floor((n - FRAME) / HOP))
  const rms = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let s = 0
    for (let i = 0; i < FRAME; i++) {
      const v = x[f * HOP + i]
      s += v * v
    }
    rms[f] = Math.sqrt(s / FRAME)
  }
  const loud = pct(Array.from(rms), 0.95) || 0
  const gate = Math.max(loud * 0.12, 0.004)
  const voiced = Array.from(rms, (r) => r > gate)

  // Pitch by normalised autocorrelation, 65–400 Hz, on the voiced frames.
  const minLag = Math.floor(RATE / 400)
  const maxLag = Math.floor(RATE / 65)
  const pitches: number[] = []
  for (let f = 0; f < frames; f += 2) {
    if (!voiced[f]) continue
    const o = f * HOP
    let e0 = 0
    for (let i = 0; i < FRAME - maxLag; i++) e0 += x[o + i] * x[o + i]
    if (e0 <= 0) continue
    let best = 0
    let bestLag = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0
      let e1 = 0
      for (let i = 0; i < FRAME - maxLag; i++) {
        s += x[o + i] * x[o + i + lag]
        e1 += x[o + i + lag] * x[o + i + lag]
      }
      const r = s / Math.sqrt(e0 * e1 || 1)
      if (r > best) {
        best = r
        bestLag = lag
      }
    }
    if (best > 0.55 && bestLag) pitches.push(RATE / bestLag)
  }

  // Syllables: peaks in the smoothed loudness, at least 110 ms apart.
  const smooth = rms.map((_, i) => {
    let s = 0
    let k = 0
    for (let j = Math.max(0, i - 3); j <= Math.min(frames - 1, i + 3); j++) {
      s += rms[j]
      k++
    }
    return s / k
  })
  let peaks = 0
  let lastPeak = -100
  for (let i = 1; i < frames - 1; i++) {
    if (smooth[i] > gate * 1.6 && smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1] && i - lastPeak >= 11) {
      peaks++
      lastPeak = i
    }
  }

  const speechFrames = voiced.filter(Boolean).length
  const speechSec = (speechFrames * HOP) / RATE
  const durationSec = n / RATE
  const f0 = pitches.length >= 10 ? median(pitches) : NaN
  const range =
    pitches.length >= 10 ? 12 * Math.log2(pct(pitches, 0.9) / Math.max(1, pct(pitches, 0.1))) : NaN
  const sps = speechSec > 1 ? peaks / speechSec : NaN

  const register = !Number.isFinite(f0)
    ? 'unclear'
    : f0 < 95
      ? 'deep male'
      : f0 < 145
        ? 'male'
        : f0 < 165
          ? 'in between'
          : f0 < 230
            ? 'female'
            : 'high female'

  const gender: VoiceSuggestion['gender'] = !Number.isFinite(f0) ? 'unclear' : f0 < 155 ? 'male' : 'female'
  // Against a typical voice of that gender as this measures them (Windows'
  // David reads ~91 Hz, Zira ~176 Hz): ~100 Hz male, ~180 Hz female, and
  // ~4.5 syllables a second of speech for an ordinary pace.
  const base = gender === 'female' ? 180 : 100
  const pitch = Number.isFinite(f0) ? Math.min(1.5, Math.max(0.5, 1 + 0.9 * Math.log2(f0 / base))) : 1
  const rate = Number.isFinite(sps) ? Math.min(1.8, Math.max(0.6, sps / 4.5)) : 1

  const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
  return {
    features: {
      durationSec: r2(durationSec) ?? 0,
      speechSec: r2(speechSec) ?? 0,
      medianPitchHz: r2(f0),
      pitchRangeSemitones: r2(range),
      syllablesPerSec: r2(sps),
      pauseRatio: r2(durationSec ? 1 - speechSec / durationSec : 0) ?? 0,
      register,
    },
    suggestion: { gender, rate: r2(rate) ?? 1, pitch: r2(pitch) ?? 1 },
  }
}
