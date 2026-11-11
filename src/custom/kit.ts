import { useEffect, useState, useSyncExternalStore } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { useStore } from '../store'

/**
 * Everything a custom layout (CustomLayout.tsx) may use: live data and
 * actions, so a layout written by JARVIS from a picture works for real rather
 * than as a mock-up. Import from './kit' — nothing else in the app.
 */

export type Status = {
  time: number
  cpu: number
  cores: number
  cpuModel: string
  memUsed: number
  memTotal: number
  uptime: number
  host: string
  user: string
  /** Their first name, from JARVIS's memory; null if unknown. */
  name: string | null
  /** GPU 3D-engine use, 0–100; refreshed every 30 s. */
  gpu: number | null
  battery: number | null
  charging: boolean
  wifi: string | null
  signal: number | null
  diskFree: number | null
  diskTotal: number | null
  weather: {
    city: string
    temp: number
    feels: number
    humidity: number
    wind: number
    cond: string
    hi: number
    lo: number
    rain: number
  } | null
  reminders: { at: string; text: string; kind: string; repeat: string | null }[]
}

// ---------------------------------------------------------------------------
// Hiding stock parts
// ---------------------------------------------------------------------------

/** Stock parts a layout can replace. */
export type StockPart =
  | 'frame' | 'header' | 'telemetry' | 'dock' | 'suggestions' | 'scene'
  | 'scanlines' | 'caption' | 'hints' | 'transcript'

let hidden: readonly string[] = []
const hiddenSubs = new Set<() => void>()

/** Set which stock parts are hidden (cl-hide-* classes, see hide.css). */
export function setHidden(parts: readonly string[]) {
  const root = document.documentElement
  for (const c of [...root.classList]) if (c.startsWith('cl-hide-')) root.classList.remove(c)
  for (const p of parts) root.classList.add(`cl-hide-${p}`)
  hidden = [...parts]
  hiddenSubs.forEach((f) => f())
}

/** The stock parts hidden right now — the app skips rendering them entirely. */
export function useHidden(): readonly string[] {
  return useSyncExternalStore(
    (f) => {
      hiddenSubs.add(f)
      return () => hiddenSubs.delete(f)
    },
    () => hidden,
  )
}

/**
 * Called at the top of a layout: the stock parts it replaces. Kept inside the
 * layout (not a second export) so the file holds nothing but the component —
 * which lets a new layout swap in live instead of reloading the page, which
 * used to cut off the conversation that asked for it.
 */
export function useHide(parts: readonly StockPart[]) {
  const key = parts.join(',')
  useEffect(() => {
    setHidden(key ? key.split(',') : [])
    return () => setHidden([])
  }, [key])
}

// The safety net (LayoutBoundary) is told to give a corrected layout another go.
const retrySubs = new Set<() => void>()
export function onLayoutRetry(fn: () => void) {
  retrySubs.add(fn)
  return () => retrySubs.delete(fn)
}
export function retryLayout() {
  retrySubs.forEach((f) => f())
}
let layoutError: string | null = null
export function reportLayoutError(message: string | null) {
  layoutError = message
}
export function lastLayoutError() {
  return layoutError
}

/** PC readings, weather and reminders from the bridge, refreshed every few seconds. */
export function useStatus(ms = 3000): Status | null {
  const [s, set] = useState<Status | null>(null)
  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/status`, { cache: 'no-store' })
        if (res.ok && alive) set(await res.json())
      } catch {
        /* bridge down: keep the last reading */
      }
    }
    void pull()
    const id = window.setInterval(pull, ms)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [ms])
  return s
}

/** Whether the microphone is muted (from the popup or by voice), refreshed every 2 s. */
export function useMuted(): boolean {
  const [m, set] = useState(false)
  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/popup/state`, { cache: 'no-store' })
        if (res.ok && alive) set(Boolean((await res.json()).muted))
      } catch {
        /* bridge down: keep the last reading */
      }
    }
    void pull()
    const id = window.setInterval(pull, 2000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])
  return m
}

/** A calendar event: a reminder, pending or already past. */
export type CalEvent = { id: string; at: string; text: string; kind: string; repeat: string | null; done: boolean }

let scheduleBump = 0
const scheduleSubs = new Set<() => void>()
const bumpSchedule = () => {
  scheduleBump++
  scheduleSubs.forEach((f) => f())
}

/** Every calendar event (refreshed every 30 s, and at once after a change). */
export function useSchedule(): CalEvent[] {
  const [events, set] = useState<CalEvent[]>([])
  const [bump, setBump] = useState(scheduleBump)
  useEffect(() => {
    const f = () => setBump(scheduleBump)
    scheduleSubs.add(f)
    return () => {
      scheduleSubs.delete(f)
    }
  }, [])
  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/schedule`, { cache: 'no-store' })
        if (res.ok && alive) set((await res.json()).events ?? [])
      } catch {
        /* bridge down: keep the last list */
      }
    }
    void pull()
    const id = window.setInterval(pull, 30_000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [bump])
  return events
}

/** Add an event at a local date and time ("2026-11-15T10:00"). Returns an error message, or null. */
export async function addEvent(at: string, text: string): Promise<string | null> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/schedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: new Date(at).toISOString(), text }),
    })
    const body = await res.json()
    bumpSchedule()
    return res.ok ? null : String(body.error ?? 'Could not save it.')
  } catch {
    return 'JARVIS is not running.'
  }
}

/** Remove an event. */
export async function removeEvent(id: string): Promise<void> {
  try {
    await fetch(`${BRIDGE_HTTP_URL}/schedule/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
  } finally {
    bumpSchedule()
  }
}

/** The current time, ticking. */
export function useNow(ms = 1000): Date {
  const [now, set] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => set(new Date()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}

export type JarvisPhase = 'offline' | 'boot' | 'dormant' | 'waking' | 'listening' | 'thinking' | 'tooling' | 'speaking'

/** JARVIS's live state: phase, voice level (0–1), the caption being heard,
 *  the conversation so far, and the tool at work. */
export function useJarvis() {
  const phase = useStore((s) => s.phase) as JarvisPhase
  const level = useStore((s) => s.level)
  const caption = useStore((s) => s.caption)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const error = useStore((s) => s.error)
  return { phase, level, caption, turns, activeTool, error }
}

/** A short word for the phase, for a status pill. */
export const phaseLabel: Record<JarvisPhase, string> = {
  offline: 'Offline',
  boot: 'Starting',
  dormant: 'Online',
  waking: 'Listening',
  listening: 'Listening',
  thinking: 'Thinking',
  tooling: 'Working',
  speaking: 'Speaking',
}

/** "Good morning" / "Good afternoon" / "Good evening". */
export function greeting(d: Date = new Date()): string {
  const h = d.getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

const post = (path: string, body?: unknown) =>
  fetch(`${BRIDGE_HTTP_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(
    (r) => r.ok,
    () => false,
  )

/** Send a typed request, exactly as if it were spoken. */
export const ask = (text: string) => (text.trim() ? post('/popup/ask', { text: text.trim() }) : Promise.resolve(false))
/** Start listening now (or, if already listening, stand by). */
export const listen = () => post('/popup/mic')
/** Mute or unmute the microphone (toggles without an argument). */
export const mute = (on?: boolean) => post('/popup/mute', on === undefined ? {} : { on })
/** Circle to Search. */
export const circle = () => post('/circle')
/** Open the onscreen popup. */
export const openPopup = () => post('/popup/show')

export type LaunchId = 'chrome' | 'files' | 'whatsapp' | 'code' | 'spotify' | 'terminal' | 'settings' | 'calculator' | 'notepad'
/** Open one of the dock apps. */
export const launch = (app: LaunchId) => post('/launch', { app })
