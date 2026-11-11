import { useEffect, useState } from 'react'
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
