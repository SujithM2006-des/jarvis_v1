import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type React from 'react'
import { ASKS_FOR_TEXT, isLongForm, renderMarkdown } from './markdown'
import {
  ask,
  greeting,
  launch,
  listen,
  openPopup,
  mute,
  phaseLabel,
  useJarvis,
  useMuted,
  useNow,
  useHide,
  useSchedule,
  addEvent,
  removeEvent,
  type CalEvent,
  useStatus,
  type JarvisPhase,
  type StockPart,
  assistantTitle,
  openSetup,
  setBrain,
  useBrains,
  useProfile,
  useSessions,
  useUsage,
  useChat,
  setChat,
  useSessionBusy,
  rateAnswer,
  retryAnswer,
  readAloud,
  stopReading,
  type Turn,
  newSession,
  switchSession,
  closeSession,
} from './kit'
import { Orb, orbInfo } from './orbs'
import './custom-layout.css'

/*
 * Custom layout — "Vanguard": a symmetric command console. A slim icon rail,
 * two equal columns of aligned glass panels either side of a neon arc
 * reactor on a holographic pad, the conversation beneath it and an ask bar
 * under that, inside a frame with matched corner brackets. Restrained glow,
 * purposeful motion, every value live.
 *
 * Written for JARVIS's customise-your-UI feature (bridge/customize.mjs): he
 * replaces this file and custom-layout.css when asked to restyle himself.
 */

/** Stock parts this layout replaces (see hide.css) — applied by useHide below. */
// The tool badge and sweeps are off too: the agent trace and the chat already
// show the tool at work, and the badge sat on top of the chat header.
const HIDE: StockPart[] = ['frame', 'header', 'telemetry', 'dock', 'suggestions', 'scene', 'scanlines', 'caption', 'hints', 'transcript', 'error', 'toolbadge', 'sweep']


// ------------------------------------------------------------------- icons

const Icon = ({ children, size = 18, w = 1.6 }: { children: ReactNode; size?: number; w?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
)

const I = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  apps: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  files: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />,
  system: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
    </>
  ),
  assistant: (
    <>
      <circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" />
    </>
  ),
  pulse: <path d="M3 12h3.5l2-5.5 4 11 2.5-7.5 1.5 2H21" />,
  bolt: <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z" />,
  cloud: <path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17M12 3.5a13 13 0 0 0 0 17" />
    </>
  ),
  code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14" />,
  music: (
    <>
      <path d="M9 18V6l11-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" />
    </>
  ),
  note: (
    <>
      <path d="M14 3H6.5A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  send: <path d="M4 12 20 4l-4.5 16-3.5-6.5z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  speaker: (
    <>
      <path d="M4 10v4h4l5 4V6L8 10z" />
      <path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  thumbUp: <path d="M7 11v9H4v-9zm0 0 4-7a2 2 0 0 1 3 2l-1 4h5.5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.3 20H7" />,
  thumbDown: <path d="M17 13V4h3v9zm0 0-4 7a2 2 0 0 1-3-2l1-4H5.5a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 6.7 4H17" />,
  retry: <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" />,
  bars: <path d="M5 20V11M10 20V5M15 20v-7M20 20V9M3 20h18" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  pencil: (
    <>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="M13.5 6.5l4 4" />
    </>
  ),
  left: <path d="M15 6l-6 6 6 6" />,
  right: <path d="M9 6l6 6-6 6" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  wifi: (
    <>
      <path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0" /><circle cx="12" cy="19" r="1" />
    </>
  ),
  battery: (
    <>
      <rect x="2.5" y="7" width="17" height="10" rx="2" /><path d="M21.5 10.5v3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
    </>
  ),
}

/** Line-art weather, chosen from the condition and gently animated. */
function WeatherArt({ cond }: { cond: string }) {
  const c = cond.toLowerCase()
  const kind = /thunder/.test(c) ? 'storm' : /rain|drizzle|shower/.test(c) ? 'rain' : /fog|mist|haze/.test(c) ? 'fog' : /overcast|cloudy/.test(c) && !/partly|mostly clear/.test(c) ? 'cloud' : /partly/.test(c) ? 'part' : 'sun'
  return (
    <svg className={`vg-wx vg-wx-${kind}`} viewBox="0 0 72 72" aria-hidden="true">
      {(kind === 'sun' || kind === 'part') && (
        <g className="vg-wx-sun">
          <circle cx={kind === 'sun' ? 36 : 28} cy={kind === 'sun' ? 34 : 26} r="10" />
          <g className="vg-wx-rays" style={{ transformOrigin: `${kind === 'sun' ? 36 : 28}px ${kind === 'sun' ? 34 : 26}px` }}>
            {Array.from({ length: 8 }, (_, i) => {
              const a = (i * Math.PI) / 4
              const cx = kind === 'sun' ? 36 : 28
              const cy = kind === 'sun' ? 34 : 26
              return <line key={i} x1={cx + Math.cos(a) * 15} y1={cy + Math.sin(a) * 15} x2={cx + Math.cos(a) * 19} y2={cy + Math.sin(a) * 19} />
            })}
          </g>
        </g>
      )}
      {kind !== 'sun' && <path className="vg-wx-cloud" d="M22 54h30a10 10 0 0 0 0-20 14 14 0 0 0-26.5 4.5A8 8 0 0 0 22 54z" />}
      {kind === 'rain' && (
        <g className="vg-wx-drops">
          <line x1="30" y1="58" x2="27" y2="65" /><line x1="40" y1="58" x2="37" y2="65" /><line x1="50" y1="58" x2="47" y2="65" />
        </g>
      )}
      {kind === 'storm' && <path className="vg-wx-bolt" d="M40 55l-5 8h6l-4 8" />}
      {kind === 'fog' && (
        <g className="vg-wx-drops">
          <line x1="18" y1="60" x2="56" y2="60" /><line x1="24" y1="66" x2="50" y2="66" />
        </g>
      )}
    </svg>
  )
}

// ------------------------------------------------------------------ pieces

function Panel({ title, icon, extra, className = '', i = 0, children }: { title: string; icon: ReactNode; extra?: ReactNode; className?: string; i?: number; children: ReactNode }) {
  return (
    <section className={`vg-panel ${className}`} style={{ '--i': i } as CSSProperties}>
      <i className="vg-tk vg-tk-tl" /><i className="vg-tk vg-tk-br" />
      <header className="vg-ph">
        <span className="vg-ph-icon"><Icon size={14}>{icon}</Icon></span>
        <span className="vg-ph-title">{title}</span>
        {extra && <span className="vg-ph-extra">{extra}</span>}
      </header>
      {children}
    </section>
  )
}

function Gauge({ label, value }: { label: string; value: number | null }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value))
  const r = 26
  const c = 2 * Math.PI * r
  return (
    <div className={`vg-gauge ${v >= 85 ? 'vg-hot' : ''}`}>
      <svg viewBox="0 0 64 64">
        <circle cx="32" cy="32" r={r} className="vg-g-track" />
        <circle cx="32" cy="32" r={r} className="vg-g-fill" strokeDasharray={`${(c * v) / 100} ${c}`} transform="rotate(-90 32 32)" />
        <circle cx="32" cy="32" r={r - 7} className="vg-g-inner" />
      </svg>
      <b>{value == null ? '--' : Math.round(v)}<small>%</small></b>
      <span>{label}</span>
    </div>
  )
}

function Meter({ icon, label, text, value }: { icon: ReactNode; label: string; text: string; value: number | null }) {
  return (
    <div className="vg-meter">
      <span className="vg-m-icon"><Icon size={13}>{icon}</Icon></span>
      <span className="vg-m-label">{label}</span>
      <span className="vg-m-text">{text}</span>
      <span className="vg-track"><i style={{ width: `${value == null ? 0 : Math.max(0, Math.min(100, value))}%` }} /></span>
    </div>
  )
}

// ---------------------------------------------------------------- calendar

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

/** Does this event fall on that day? Repeating ones recur from their start. */
function onDay(e: CalEvent, day: Date) {
  const at = new Date(e.at)
  if (ymd(at) === ymd(day)) return true
  if (e.done || !e.repeat) return false
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate())
  if (day < start) return false
  if (e.repeat === 'daily') return true
  if (e.repeat === 'weekly') return day.getDay() === at.getDay()
  return false
}

const timeOf = (e: CalEvent) => new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/**
 * The month, with a dot on days that have events. Click a day for what is on
 * it; ＋ to add one (a reminder, so it also pops up when due). Events also
 * arrive from voice: "Jarvis, remind me on the 15th to …".
 */
/** The calendar, opened from "View calendar" on the Local Time box. */
function Calendar({ i, onClose }: { i: number; onClose?: () => void }) {
  const events = useSchedule()
  const today = new Date()
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const [picked, setPicked] = useState<Date | null>(null)
  const [adding, setAdding] = useState(false)
  const [date, setDate] = useState(ymd(today))
  const [time, setTime] = useState('09:00')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  // A picked day's events are below the month: scroll them into view.
  const dropRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (picked) dropRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [picked])

  // Monday-first grid: blanks before the 1st, then each day of the month.
  const first = (month.getDay() + 6) % 7
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells: (Date | null)[] = [
    ...Array.from({ length: first }, () => null),
    ...Array.from({ length: days }, (_, d) => new Date(month.getFullYear(), month.getMonth(), d + 1)),
  ]
  const dayEvents = (d: Date) => events.filter((e) => onDay(e, d)).sort((a, b) => timeOf(a).localeCompare(timeOf(b)))

  const openAdd = (d?: Date) => {
    setDate(ymd(d ?? picked ?? today))
    setText('')
    setError('')
    setAdding(true)
  }
  const save = async () => {
    if (!text.trim()) return setError('Say what the event is.')
    const err = await addEvent(`${date}T${time || '09:00'}`, text.trim())
    if (err) return setError(err)
    setAdding(false)
    setPicked(new Date(`${date}T00:00`))
    setMonth(new Date(new Date(`${date}T00:00`).getFullYear(), new Date(`${date}T00:00`).getMonth(), 1))
  }

  return (
    <Panel
      title="Calendar"
      icon={I.calendar}
      i={i}
      className="vg-cal"
      extra={
        <>
          <button type="button" className="vg-icon-btn" title={adding ? 'Cancel' : 'Add an event'} onClick={() => (adding ? setAdding(false) : openAdd())}>
            <Icon size={14} w={2}>{adding ? I.close : I.plus}</Icon>
          </button>
          {onClose && (
            <button type="button" className="vg-icon-btn vg-cal-close" title="Close the calendar" aria-label="Close the calendar" onClick={onClose}>
              <Icon size={14} w={2}>{I.close}</Icon>
            </button>
          )}
        </>
      }
    >
      <div className="vg-cal-head">
        <button type="button" className="vg-cal-nav" title="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
          <Icon size={14} w={2}>{I.left}</Icon>
        </button>
        <span>{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
        <button type="button" className="vg-cal-nav" title="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
          <Icon size={14} w={2}>{I.right}</Icon>
        </button>
      </div>

      {adding ? (
        <div className="vg-cal-form">
          <label>
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Time
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <input
            className="vg-cal-text"
            autoFocus
            placeholder="What's happening? e.g. DBMS lab exam"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              if (e.key === 'Escape') setAdding(false)
            }}
          />
          {error && <span className="vg-cal-error">{error}</span>}
          <div className="vg-cal-actions">
            <button type="button" className="vg-cal-cancel" onClick={() => setAdding(false)}>Cancel</button>
            <button type="button" className="vg-cal-save" onClick={() => void save()}>Save event</button>
          </div>
        </div>
      ) : (
        <>
          <div className="vg-cal-grid">
            {WEEKDAYS.map((w) => (
              <span key={w} className="vg-cal-wd">{w}</span>
            ))}
            {cells.map((d, k) =>
              d ? (
                <button
                  key={k}
                  type="button"
                  className={[
                    'vg-cal-day',
                    ymd(d) === ymd(today) ? 'vg-today' : '',
                    picked && ymd(d) === ymd(picked) ? 'vg-picked' : '',
                    dayEvents(d).length ? 'vg-has' : '',
                  ].join(' ')}
                  onClick={() => setPicked(picked && ymd(d) === ymd(picked) ? null : d)}
                  onDoubleClick={() => openAdd(d)}
                  title={dayEvents(d).length ? `${dayEvents(d).length} event(s)` : 'No events'}
                >
                  {d.getDate()}
                </button>
              ) : (
                <span key={k} />
              ),
            )}
          </div>

          {picked && (
            <div className="vg-cal-drop" ref={dropRef}>
              <div className="vg-cal-drop-head">
                <b>{picked.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</b>
                <span className="vg-cal-drop-btns">
                  <button type="button" className="vg-cal-add-day" onClick={() => openAdd(picked)}>
                    <Icon size={12} w={2}>{I.plus}</Icon> Add
                  </button>
                  <button type="button" className="vg-cal-del" title="Close" onClick={() => setPicked(null)}>
                    <Icon size={12} w={2}>{I.close}</Icon>
                  </button>
                </span>
              </div>
              {dayEvents(picked).length === 0 ? (
                <div className="vg-cal-none">No event specified</div>
              ) : (
                <ul>
                  {dayEvents(picked).map((e) => (
                    <li key={`${e.id}-${e.at}`} className={e.done ? 'vg-cal-past' : ''}>
                      <span className="vg-cal-time">{timeOf(e)}</span>
                      <span className="vg-cal-what">
                        {e.text}
                        {e.repeat && <em> · {e.repeat}</em>}
                      </span>
                      <button type="button" className="vg-cal-del" title="Remove" onClick={() => void removeEvent(e.id)}>
                        <Icon size={12} w={2}>{I.close}</Icon>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </Panel>
  )
}

/** Vertical bars, symmetric about the middle, moving with his voice. */
function Wave({ level, bars = 27, idle = 0.1, className = '' }: { level: number; bars?: number; idle?: number; className?: string }) {
  // Fast only while there is a voice to follow; idle, a slow drift is enough
  // and saves re-rendering a dozen times a second for nothing.
  const now = useNow(level > 0.02 ? 80 : 500)
  const t = now.getTime() / 140
  const live = Math.max(idle, Math.min(1, level * 2.4))
  return (
    <div className={`vg-wave ${className}`} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => {
        const mid = 1 - Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2)
        const h = 0.12 + mid * mid * live * (0.55 + 0.45 * Math.abs(Math.sin(t + i * 0.9)))
        return <span key={i} style={{ height: `${Math.round(Math.min(1, h) * 100)}%` }} />
      })}
    </div>
  )
}

/** The centre: the orb chosen in setup, live to his phase, with his name and line. */
/**
 * A slow glide between two places in the layout (FLIP): measure where the
 * element is before `key` changes, let it jump to its new place, then start it
 * from the old place and size and let it travel. Uses the separate `translate`
 * and `scale` properties so the element's own transform animations stay free.
 */
function useGlide(ref: React.RefObject<HTMLElement | null>, key: unknown, ms = 1100) {
  const last = useRef(key)
  const from = useRef<DOMRect | null>(null)
  if (last.current !== key) {
    // Read in render, before React moves it: where it is now.
    from.current = ref.current?.getBoundingClientRect() ?? null
    last.current = key
  }
  useLayoutEffect(() => {
    const el = ref.current
    const a = from.current
    from.current = null
    if (!el || !a) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const b = el.getBoundingClientRect()
    if (!b.width || !b.height) return
    el.style.transition = 'none'
    el.style.transformOrigin = 'top left'
    el.style.translate = `${a.left - b.left}px ${a.top - b.top}px`
    el.style.scale = `${a.width / b.width}`
    el.getBoundingClientRect() // commit the start before animating
    requestAnimationFrame(() => {
      el.style.transition = `translate ${ms}ms cubic-bezier(.22,.8,.2,1), scale ${ms}ms cubic-bezier(.22,.8,.2,1)`
      el.style.translate = ''
      el.style.scale = ''
    })
  }, [key, ms, ref])
}

function Reactor({
  phase,
  level,
  line,
  orb,
  title,
  mini = false,
  onExpand,
}: {
  phase: JarvisPhase
  level: number
  line: string
  orb: string
  title: string
  /** The chat view: small, in the top-right corner. */
  mini?: boolean
  onExpand?: () => void
}) {
  const voiced = phase === 'speaking' || phase === 'listening' || phase === 'waking'
  const state = (phaseLabel[phase] ?? 'Online').toUpperCase()
  const legend = `${title}  ·  NEURAL CORE  ·  ${state}  ·  VOICE LINK  ·  ${title}  ·  NEURAL CORE  ·  ${state}  ·  VOICE LINK  ·`
  const ref = useRef<HTMLDivElement>(null)
  useGlide(ref, mini)
  return (
    <div
      ref={ref}
      className={`vg-reactor vg-ph-${phase} vg-orb-${orbInfo(orb).id} ${orbInfo(orb).textBelow ? 'vg-orb-below' : ''} ${mini ? 'vg-reactor-mini' : ''}`}
      {...(mini && onExpand
        ? { role: 'button', tabIndex: 0, title: 'Back to the orb view', onClick: onExpand, onKeyDown: (e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && onExpand() }
        : {})}
    >
      <div className="vg-halo" />
      <Orb id={orb} phase={phase} level={level} legend={legend} className="vg-r-svg" />
      <div className="vg-r-text">
        <span className="vg-r-kicker">{phaseLabel[phase] ?? 'Online'}</span>
        <h1>{title}</h1>
        <p>{line}</p>
        <Wave level={voiced ? level : 0} idle={voiced ? 0.22 : 0.1} />
      </div>
      <div className="vg-pad">
        <div className="vg-beam" />
        <div className="vg-pad-glow" />
        <div className="vg-pad-ring" />
        <div className="vg-pad-ring vg-r2" />
        <div className="vg-pad-ring vg-r3" />
      </div>
    </div>
  )
}

/** A written answer as one short plain line (no code, marks or tables), for the orb view. */
function plainPreview(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '· ')
    .replace(/[*_~`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 220 ? `${plain.slice(0, 218).replace(/\s+\S*$/, '')}…` : plain
}

/** Copy text, briefly showing "Copied" on the button. */
function useCopy(): [string | null, (key: string, text: string) => void] {
  const [done, setDone] = useState<string | null>(null)
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setDone(key)
      window.setTimeout(() => setDone((d) => (d === key ? null : d)), 1400)
    })
  }
  return [done, copy]
}

/** A written answer: formatted, with a copy button on each code block. */
function Written({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = renderMarkdown(text)
  useEffect(() => {
    ref.current?.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.md-copy')) return
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'md-copy'
      b.textContent = 'Copy'
      b.onclick = () => {
        void navigator.clipboard?.writeText(pre.querySelector('code')?.textContent ?? '').then(() => {
          b.textContent = 'Copied'
          window.setTimeout(() => (b.textContent = 'Copy'), 1400)
        })
      }
      pre.appendChild(b)
    })
  }, [html])
  return <div ref={ref} className="vg-md" dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * Under a finished answer, on the left: copy, read aloud (again to stop),
 * thumbs up, thumbs down (with an optional "what was wrong?"), and retry
 * (the latest answer only: asks again for a different one, replacing it).
 */
function AnswerActions({ turn, request, requestId, latest }: { turn: Turn; request: string; requestId: string | null; latest: boolean }) {
  const [copied, setCopied] = useState(false)
  const [reading, setReading] = useState(false)
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const [thanks, setThanks] = useState(false)
  useEffect(() => {
    if (!reading) return
    const done = () => setReading(false)
    window.addEventListener('jarvis-read-done', done)
    return () => window.removeEventListener('jarvis-read-done', done)
  }, [reading])
  const vote = (v: 'up' | 'down') => {
    const next = turn.feedback === v ? null : v
    void rateAnswer(turn.id, next, request, turn.text)
    setAsking(next === 'down')
    setThanks(next === 'up')
    if (next === 'up') window.setTimeout(() => setThanks(false), 1600)
  }
  return (
    <div className="vg-acts">
      <div className="vg-acts-row">
        <button
          type="button"
          title={copied ? 'Copied' : 'Copy'}
          aria-label="Copy"
          onClick={() =>
            void navigator.clipboard?.writeText(turn.text).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1400)
            })
          }
        >
          <Icon size={15}>{copied ? I.check : I.copy}</Icon>
        </button>
        <button
          type="button"
          className={reading ? 'vg-on' : ''}
          title={reading ? 'Stop reading' : 'Read aloud'}
          aria-label={reading ? 'Stop reading' : 'Read aloud'}
          aria-pressed={reading}
          onClick={() => {
            if (reading) {
              stopReading()
              setReading(false)
            } else {
              readAloud(turn.text)
              setReading(true)
            }
          }}
        >
          <Icon size={15}>{reading ? I.stop : I.speaker}</Icon>
        </button>
        <button
          type="button"
          className={turn.feedback === 'up' ? 'vg-on' : ''}
          title="Good answer"
          aria-label="Good answer"
          aria-pressed={turn.feedback === 'up'}
          onClick={() => vote('up')}
        >
          <Icon size={15}>{I.thumbUp}</Icon>
        </button>
        <button
          type="button"
          className={turn.feedback === 'down' ? 'vg-on vg-bad' : ''}
          title="Bad answer"
          aria-label="Bad answer"
          aria-pressed={turn.feedback === 'down'}
          onClick={() => vote('down')}
        >
          <Icon size={15}>{I.thumbDown}</Icon>
        </button>
        {latest && requestId && (
          <button type="button" title="Try again (a different answer)" aria-label="Retry" onClick={() => void retryAnswer(requestId, request)}>
            <Icon size={15}>{I.retry}</Icon>
          </button>
        )}
        {thanks && <span className="vg-acts-note">Thanks, noted.</span>}
      </div>
      {asking && (
        <form
          className="vg-acts-why"
          onSubmit={(e) => {
            e.preventDefault()
            void rateAnswer(turn.id, 'down', request, turn.text, reason)
            setAsking(false)
            setReason('')
          }}
        >
          <input autoFocus value={reason} placeholder="What was wrong with it? (optional)" onChange={(e) => setReason(e.target.value)} />
          <button type="submit">Send</button>
          <button type="button" onClick={() => setAsking(false)}>
            Skip
          </button>
        </form>
      )}
    </div>
  )
}

/**
 * The chat view, in place of the orb and the short transcript: the whole
 * conversation of the session on screen, answers written out and formatted —
 * like a chat app, in JARVIS's style. The orb sits small in the corner; it (or
 * "Orb view") brings the orb back.
 */
function ChatView({ title, assistant, onClose }: { title: string; assistant: string; onClose: () => void }) {
  const { turns, phase, activeTool } = useJarvis()
  const busy = useSessionBusy()
  const [copied, copy] = useCopy()
  const ref = useRef<HTMLDivElement>(null)
  // Follow new text while the reader is at the bottom; leave them be if they
  // have scrolled up to read.
  const follow = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [turns, busy])
  const last = turns[turns.length - 1]
  const waiting = busy && (!last || last.role === 'user')
  const doing =
    phase === 'tooling' && activeTool ? activeTool.replace(/^mcp__[^_]+(_[^_]+)*__/, '').replace(/[_-]+/g, ' ') : 'Thinking'
  return (
    <section className="vg-chatview" aria-label="Chat">
      <header className="vg-chat-head">
        <Icon size={15}>{I.chat}</Icon>
        <h2 title={title}>{title}</h2>
        <button type="button" className="vg-chat-orb" onClick={onClose} title="Back to the orb view">
          <Icon size={13} w={2}>{I.close}</Icon>
          Orb view
        </button>
      </header>
      <div
        className="vg-chat-scroll"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="vg-chat-list">
          {turns.length === 0 && <div className="vg-chat-empty">Ask for anything written — an essay, a script, code, a plan — and it appears here.</div>}
          {turns.map((t, k) =>
            t.role === 'user' ? (
              <div key={t.id} className="vg-cm vg-cm-user">
                <div className="vg-cm-bubble">{t.text}</div>
                <button type="button" className="vg-cm-copy" onClick={() => copy(t.id, t.text)}>
                  {copied === t.id ? 'Copied' : 'Copy'}
                </button>
              </div>
            ) : (
              <div key={t.id} className={`vg-cm vg-cm-ai ${busy && k === turns.length - 1 ? 'vg-cm-live' : ''}`}>
                <span className="vg-cm-who">
                  <span className="vg-badge">{assistant.slice(0, 1).toUpperCase()}</span>
                  {assistant}
                </span>
                <Written text={t.text} />
                {!(busy && k === turns.length - 1) && t.text && (
                  <AnswerActions
                    turn={t}
                    request={[...turns.slice(0, k)].reverse().find((u) => u.role === 'user')?.text ?? ''}
                    requestId={[...turns.slice(0, k)].reverse().find((u) => u.role === 'user')?.id ?? null}
                    latest={!busy && turns.slice(k + 1).every((u) => u.role !== 'jarvis')}
                  />
                )}
              </div>
            ),
          )}
          {waiting && (
            <div className="vg-cm vg-cm-ai vg-cm-wait">
              <span className="vg-cm-who">
                <span className="vg-badge">{assistant.slice(0, 1).toUpperCase()}</span>
                {assistant}
              </span>
              <span className="vg-typing">
                <i />
                <i />
                <i />
                {doing}…
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/** One step of what he is doing for the current request. */
type Step = { id: number; label: string; kind: 'listen' | 'think' | 'tool' | 'speak' | 'done'; at: string }

const toolLabel = (t: string) => t.replace(/^mcp__[^_]+(_[^_]+)*__/, '').replace(/[_-]+/g, ' ').trim()

/** The agent trace: Listening › Thinking › <tools> › Responding › Done. */
function AgentTrace({ steps }: { steps: Step[] }) {
  if (!steps.length) return null
  return (
    <div className="vg-trace">
      <span className="vg-trace-k">Agent</span>
      {steps.map((s, i) => (
        <Fragment key={s.id}>
          {i > 0 && <span className="vg-trace-arrow">›</span>}
          <span className={`vg-step vg-step-${s.kind} ${i === steps.length - 1 && s.kind !== 'done' ? 'vg-step-live' : ''}`}>
            <i />
            {s.label}
            <small>{s.at}</small>
          </span>
        </Fragment>
      ))}
    </div>
  )
}

const SUGGESTIONS = [
  'Brief me',
  "What's on my calendar today?",
  'Weather here',
  'Which apps use the most memory?',
  'Any unread WhatsApp messages?',
]

function Conversation({ idle }: { idle: boolean }) {
  const { turns } = useJarvis()
  const ref = useRef<HTMLDivElement>(null)
  const recent = turns.slice(-4)
  // Correcting a request (the pencil): edit it in place and send it again.
  // Sending stops whatever he was doing for the wrong one and starts afresh.
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const resend = () => {
    const t = draft.trim()
    if (t) void ask(t)
    setEditing(null)
  }
  useEffect(() => {
    if (ref.current && !editing) ref.current.scrollTop = ref.current.scrollHeight
  }, [turns, editing])
  return (
    <div className="vg-convo-wrap">
      <div className="vg-convo" ref={ref}>
        {recent.length === 0 ? (
          <div className="vg-convo-empty">Say “Hey Jarvis”, tap the mic, or type below.</div>
        ) : (
          recent.map((t) => (
            <div key={t.id} className={`vg-msg vg-${t.role}`}>
              <span className="vg-who">
                <span className="vg-badge">{t.role === 'user' ? 'U' : 'J'}</span>
                {t.role === 'user' ? 'You' : 'Jarvis'}
              </span>
              {t.role === 'user' && editing === t.id ? (
                <span className="vg-edit">
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') resend()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                  <button type="button" className="vg-edit-ok" title="Send the corrected request" onClick={resend}>
                    <Icon size={14} w={2.2}>{I.check}</Icon>
                  </button>
                  <button type="button" className="vg-edit-x" title="Cancel" onClick={() => setEditing(null)}>
                    <Icon size={14} w={2}>{I.close}</Icon>
                  </button>
                </span>
              ) : (
                <>
                  {t.role === 'jarvis' && isLongForm(t.text) ? (
                    // A written answer: a clean preview here, in full in the chat.
                    <span className="vg-said">
                      {plainPreview(t.text)}
                      <button type="button" className="vg-open-chat" onClick={() => setChat(true)}>
                        Open chat
                      </button>
                    </span>
                  ) : (
                    <span className="vg-said">{t.text}</span>
                  )}
                  {t.role === 'user' && (
                    <button
                      type="button"
                      className="vg-pencil"
                      title="Edit this request and send it again"
                      onClick={() => {
                        setDraft(t.text)
                        setEditing(t.id)
                      }}
                    >
                      <Icon size={14}>{I.pencil}</Icon>
                    </button>
                  )}
                </>
              )}
            </div>
          ))
        )}
      </div>
      {/* Idle: a few one-tap requests, like any good agent console. */}
      {idle && (
        <div className="vg-suggest">
          {SUGGESTIONS.map((q) => (
            <button key={q} type="button" onClick={() => void ask(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** "now", "5m", "3h", "Mon", "12 Nov" — how long since a session was used. */
function ago(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  const d = new Date(at)
  return s < 6 * 86400 ? d.toLocaleDateString('en-US', { weekday: 'short' }) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/**
 * Sessions, named after their first request. Each runs on its own agent, so
 * one can work on a long job while another is used; the dot spins on the ones
 * still working. + starts a new one; × closes one (and stops its agent).
 */
function Sessions({ i }: { i: number }) {
  const { sessions, active } = useSessions()
  const now = useNow(30_000).getTime()
  const working = sessions.filter((x) => x.busy).length
  return (
    <Panel
      title="Sessions"
      icon={I.chat}
      i={i}
      className="vg-sessions"
      extra={
        <>
          {working > 0 && <span className="vg-ses-count">{working} working</span>}
          <button type="button" className="vg-ses-new" title="New session" aria-label="New session" onClick={() => newSession()}>
            <Icon size={15} w={2.2}>{I.plus}</Icon>
          </button>
        </>
      }
    >
      <ul className="vg-ses-list">
        {sessions.map((x) => (
          <li key={x.id} className={`${x.id === active ? 'vg-ses-on' : ''} ${x.busy ? 'vg-ses-busy' : ''}`}>
            <button type="button" className="vg-ses-open" title={x.title} onClick={() => switchSession(x.id)}>
              <i className="vg-ses-dot" />
              <span className="vg-ses-title">{x.title}</span>
              <small>{x.busy ? 'working' : ago(x.at, now)}</small>
            </button>
            <button
              type="button"
              className="vg-ses-x"
              title={x.busy ? 'Stop and close this session' : 'Close this session'}
              aria-label={`Close ${x.title}`}
              onClick={() => closeSession(x.id)}
            >
              <Icon size={12} w={2}>{I.close}</Icon>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/** 1234 → "1.2K", 3400000 → "3.4M". */
const kmb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)))

/** "Resets at 3:40 PM" today, else "Resets Sun, Nov 15 at 6:30 PM". */
function resets(at?: string | null): string | null {
  if (!at) return null
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return null
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return `Resets at ${time}`
  return `Resets ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`
}

/**
 * Model usage, like the Claude app's usage page: for every connected AI, how
 * much of each limit is used (Claude's 5-hour and weekly windows; OpenRouter's
 * and Groq's daily requests), when it resets, and the tokens Jarvis used on it
 * today or this week. NOW = answering; RESTING = hit its limit, Auto moved on.
 */
function ModelUsage({ i }: { i: number }) {
  const u = useUsage()
  const [range, setRange] = useState<'today' | 'week'>('today')
  const lines = u ? u[range] : {}
  const ids = u ? u.brains.options.map((o) => o.id).filter((id) => u.limits?.[id] || lines[id]) : []
  const sum = Object.values(lines).reduce(
    (a, l) => ({ requests: a.requests + l.requests, tokens: a.tokens + l.input + l.cached + l.output, cost: a.cost + l.cost }),
    { requests: 0, tokens: 0, cost: 0 },
  )
  return (
    <Panel
      title="Model Usage"
      icon={I.bars}
      i={i}
      className="vg-usage"
      extra={
        <span className="vg-use-tabs" role="tablist" title="Tokens Jarvis used">
          {(['today', 'week'] as const).map((r) => (
            <button key={r} type="button" role="tab" aria-selected={range === r} className={range === r ? 'vg-on' : ''} onClick={() => setRange(r)}>
              {r === 'today' ? 'Today' : '7 days'}
            </button>
          ))}
        </span>
      }
    >
      {!u ? (
        <div className="vg-use-empty">Reading usage…</div>
      ) : (
        <>
          <ul className="vg-use-list">
            {ids.map((id) => {
              const lim = u.limits?.[id]
              const l = lines[id]
              const opt = u.brains.options.find((o) => o.id === id)
              const resting = /limit/.test(opt?.unavailable ?? '')
              return (
                <li key={id} className={id === u.brains.active ? 'vg-use-active' : ''}>
                  <div className="vg-use-row">
                    <span className="vg-use-name">{u.labels[id] ?? id}</span>
                    {id === u.brains.active && <em className="vg-use-tag">now</em>}
                    {resting && <em className="vg-use-tag vg-use-rest">resting</em>}
                    {lim?.note && <span className="vg-use-note">{lim.note}</span>}
                  </div>
                  {lim?.meters.map((m) => {
                    const when = resets(m.resetsAt)
                    return (
                      <div key={m.label} className={`vg-use-meter ${m.pct >= 90 ? 'vg-hot' : m.pct >= 70 ? 'vg-warm' : ''}`}>
                        <div className="vg-use-mrow">
                          <span>{m.label}</span>
                          <b>{m.pct}%</b>
                        </div>
                        <div className="vg-use-bar">
                          <span style={{ width: `${Math.max(m.pct, m.pct > 0 ? 1.5 : 0)}%` }} />
                        </div>
                        {(when || m.detail) && <small>{[m.detail, when].filter(Boolean).join(' · ')}</small>}
                      </div>
                    )
                  })}
                  <div className="vg-use-detail">
                    {l
                      ? `${l.requests} request${l.requests === 1 ? '' : 's'} · ${kmb(l.input + l.cached + l.output)} tokens ${range === 'today' ? 'today' : 'this week'}`
                      : `Not used ${range === 'today' ? 'today' : 'this week'}`}
                    {l && l.limits > 0 && ` · ${l.limits} limit hit${l.limits > 1 ? 's' : ''}`}
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="vg-use-foot">
            <span>{sum.requests} request{sum.requests === 1 ? '' : 's'}</span>
            <span>{kmb(sum.tokens)} tokens</span>
            {sum.cost > 0 && <span title="What these requests would cost on the paid API (estimate)">≈ ${sum.cost.toFixed(2)} API value</span>}
          </div>
        </>
      )}
    </Panel>
  )
}

/** The model dropdown, left of the text box: Auto, or one AI to think with. */
function BrainPick() {
  const b = useBrains()
  if (!b) return null
  const fellBack = b.choice !== 'auto' && b.active && b.active !== b.choice
  return (
    <label className={`vg-brain ${fellBack ? 'vg-brain-fb' : ''}`} title={`Answering now: ${b.activeLabel}`}>
      <select value={b.choice} onChange={(e) => void setBrain(e.target.value)} aria-label="AI model">
        <option value="auto">Auto · {b.activeLabel}</option>
        {b.options.map((o) => (
          <option key={o.id} value={o.id} disabled={Boolean(o.unavailable) && o.unavailable !== 'starting'}>
            {o.label}
            {o.unavailable ? ` — ${o.unavailable}` : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
function AskBar() {
  const { phase, level, caption, error } = useJarvis()
  const muted = useMuted()
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const inChat = useChat()
  const listening = !muted && (phase === 'listening' || phase === 'waking')
  const send = () => {
    if (!text.trim()) return
    // A typed request for written content ("write…", "explain…", "code…")
    // opens the chat view before it is sent, so the answer is written out.
    if (ASKS_FOR_TEXT.test(text)) setChat(true)
    void ask(text)
    setText('')
  }
  // The box grows with its lines (Shift+Enter), up to a few, then scrolls.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
    el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden'
  }, [text])
  return (
    <div className={`vg-ask ${listening ? 'vg-live' : ''}`}>
      {error && <div className="vg-ask-error" role="alert">{error}</div>}
      <BrainPick />
      <Wave level={listening ? level : 0} bars={7} idle={listening ? 0.45 : 0.3} className="vg-ask-wave" />
      {/* Enter sends; Shift+Enter starts a new line. */}
      <textarea
        ref={box}
        rows={1}
        value={text}
        placeholder={muted ? 'Microphone muted — type here, or tap the mic to unmute' : listening ? caption || 'Listening…' : inChat ? 'Reply…  (Shift+Enter for a new line)' : 'Ask me anything…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
      />
      {/* Muted: the mic shows it, and a tap unmutes and listens. */}
      <button
        type="button"
        className={`vg-mic ${muted ? 'vg-muted' : ''}`}
        title={muted ? 'Microphone muted — tap to unmute' : listening ? 'Stand by' : 'Talk to JARVIS'}
        onClick={() => void listen()}
      >
        <Icon size={20}>{I.mic}</Icon>
      </button>
      {/* Mute: stop him listening for a while; tap again (or the mic) to unmute. */}
      <button
        type="button"
        className={`vg-mute ${muted ? 'vg-mute-on' : ''}`}
        title={muted ? 'Microphone muted — tap to unmute' : 'Mute the microphone'}
        aria-pressed={muted}
        onClick={() => void mute(!muted)}
      >
        <Icon size={18}>
          {I.mic}
          <path d="M4 4l16 16" />
        </Icon>
      </button>
      <button type="button" className="vg-send" title="Send" onClick={send} disabled={!text.trim()}>
        <Icon size={18}>{I.send}</Icon>
      </button>
    </div>
  )
}

const uptime = (s: number) => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`
}

// ------------------------------------------------------------------ layout

/** The avatar at the foot of the rail, and its menu: customise the assistant. */
function Me({ name, assistant }: { name: string; assistant: string }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (!(e.target as Element).closest?.('.vg-me')) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div className="vg-me">
      <button
        type="button"
        className={`vg-avatar ${open ? 'vg-avatar-on' : ''}`}
        title={name}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {name[0].toUpperCase()}
      </button>
      {open && (
        <div className="vg-me-menu" role="menu">
          <div className="vg-me-head">
            <b>{name}</b>
            <small>{assistant}</small>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              openSetup()
            }}
          >
            <Icon size={16}>{I.settings}</Icon>
            Customize {assistant}
          </button>
        </div>
      )}
    </div>
  )
}
export default function CustomLayout() {
  useHide(HIDE)
  const now = useNow(1000)
  const s = useStatus()
  const { phase, level, caption, activeTool } = useJarvis()
  const muted = useMuted()
  const [nav, setNav] = useState('home')
  // Their name from JARVIS's memory; "sir" until he knows it.
  const NAME = s?.name || 'sir'

  // The agent trace for the current request, built from his phase changes.
  const [trace, setTrace] = useState<Step[]>([])
  const stepId = useRef(0)
  useEffect(() => {
    const at = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).replace(/\s?[AP]M$/, '')
    if (phase === 'dormant') {
      setTrace((t) => (t.length && t[t.length - 1].kind !== 'done' ? [...t, { id: ++stepId.current, label: 'Done', kind: 'done', at }] : t))
      return
    }
    const step: Pick<Step, 'label' | 'kind'> | null =
      phase === 'listening' || phase === 'waking'
        ? { label: 'Listening', kind: 'listen' }
        : phase === 'thinking'
          ? { label: 'Thinking', kind: 'think' }
          : phase === 'tooling'
            ? { label: activeTool ? toolLabel(activeTool) : 'Working', kind: 'tool' }
            : phase === 'speaking'
              ? { label: 'Responding', kind: 'speak' }
              : null
    if (!step) return
    setTrace((t) => {
      if (t.length && t[t.length - 1].label === step.label) return t
      // A new request (listening after a finished one) starts a fresh trace.
      const base = step.kind === 'listen' && (!t.length || t[t.length - 1].kind === 'done') ? [] : t
      return [...base, { id: ++stepId.current, ...step, at }].slice(-7)
    })
  }, [phase, activeTool])

  const hm = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).split(' ')[0]
  const ampm = now.getHours() < 12 ? 'AM' : 'PM'
  const secs = now.getSeconds()
  const mem = s ? (s.memUsed / s.memTotal) * 100 : null
  const disk = s && s.diskTotal && s.diskFree != null ? ((s.diskTotal - s.diskFree) / s.diskTotal) * 100 : null
  const w = s?.weather
  const next = s?.reminders?.[0]
  const greet = greeting(now).replace(/\b\w/g, (m) => m.toUpperCase())

  const line =
    phase === 'listening' || phase === 'waking'
      ? caption || "I'm listening."
      : phase === 'thinking'
        ? 'Processing your request'
        : phase === 'tooling'
          ? activeTool
            ? activeTool.replace(/^mcp__[^_]+(_[^_]+)*__/, '').replace(/[_-]/g, ' ')
            : 'Working on it'
          : phase === 'speaking'
            ? 'Responding'
            : phase === 'offline'
              ? 'Offline'
              : `At your service, ${NAME}`

  const profile = useProfile()
  const navItems = [
    { id: 'home', label: 'Home', icon: I.home },
    { id: 'apps', label: 'Apps', icon: I.apps, run: () => void ask('Which apps are open right now?') },
    { id: 'files', label: 'Files', icon: I.files, run: () => void launch('files') },
    { id: 'system', label: 'System', icon: I.system, run: () => void ask("How's my laptop doing?") },
    { id: 'settings', label: 'Settings', icon: I.settings, run: () => void launch('settings') },
    { id: 'assistant', label: 'Assistant', icon: I.assistant, run: () => void openPopup() },
  ]

  const secC = 2 * Math.PI * 30

  // The chat view, per session. It comes on by itself when an answer turns out
  // to be written content (long, or formatted); the orb (or "Orb view") ends it.
  const chat = useChat()
  const { sessions: allSessions, active: activeId } = useSessions()
  const activeTitle = allSessions.find((x) => x.id === activeId)?.title ?? 'Chat'
  const { turns: shown } = useJarvis()
  const lastTurn = shown[shown.length - 1]
  const lastText = lastTurn?.role === 'jarvis' ? lastTurn.text : ''
  const answering = useSessionBusy()
  // Only while an answer is arriving — and never again for one the user has
  // closed the chat on (so "Orb view" stays put).
  const dismissed = useRef(new Set<string>())
  useEffect(() => {
    if (!chat && answering && lastTurn && lastText && !dismissed.current.has(lastTurn.id) && isLongForm(lastText)) setChat(true)
  }, [chat, answering, lastTurn, lastText])
  const closeChat = () => {
    if (lastTurn) dismissed.current.add(lastTurn.id)
    setChat(false)
  }

  // The calendar is shown on demand, from the Local Time box.
  const [calOpen, setCalOpen] = useState(false)
  useEffect(() => {
    if (!calOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setCalOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [calOpen])

  return (
    <div className={`vg-root vg-ph-${phase} ${chat ? 'vg-chat' : ''}`}>
      <div className="vg-bg" aria-hidden="true">
        <div className="vg-grid" />
        {Array.from({ length: 16 }, (_, i) => (
          <span key={i} className="vg-mote" style={{ '--x': `${(i * 61) % 100}%`, '--d': `${16 + (i % 5) * 4}s`, '--delay': `${-i * 2.1}s` } as CSSProperties} />
        ))}
      </div>
      <div className="vg-frame" aria-hidden="true">
        <i className="vg-c vg-c-tl" /><i className="vg-c vg-c-tr" /><i className="vg-c vg-c-bl" /><i className="vg-c vg-c-br" />
        <i className="vg-scan" />
      </div>

      {/* Header */}
      <header className="vg-head">
        <div className="vg-logo"><i /><i /></div>
        <div className="vg-brand">
          <strong>{assistantTitle(profile)}</strong>
          <small>Personal AI Assistant</small>
        </div>
        <div className="vg-head-mid">
          <span className="vg-hm-line" />
          {/* Live system chips: the link to the brain, voice and microphone. */}
          <span className="vg-sys">
            <span className={`vg-sc ${phase !== 'offline' && s ? 'vg-ok' : 'vg-bad'}`}>
              <i />
              Link
            </span>
            <span className={`vg-sc ${phase === 'offline' ? 'vg-bad' : 'vg-ok'}`}>
              <span className="vg-eq"><i /><i /><i /><i /></span>
              Voice · {phaseLabel[phase] ?? 'Online'}
            </span>
            <button
              type="button"
              className={`vg-sc vg-sc-btn ${muted ? 'vg-bad' : 'vg-ok'}`}
              title={muted ? 'Tap to unmute the microphone' : 'Tap to mute the microphone'}
              onClick={() => void mute(!muted)}
            >
              <i />
              Mic {muted ? 'muted' : 'live'}
            </button>
          </span>
          <span className="vg-hm-line vg-flip" />
        </div>
        <div className="vg-head-right">
          {muted ? (
            <button type="button" className="vg-pill vg-pill-muted" title="Tap to unmute" onClick={() => void mute(false)}>
              <i />
              Muted
            </button>
          ) : (
            <span className={`vg-pill vg-pill-${phase}`}>
              <i />
              {phaseLabel[phase] ?? 'Online'}
            </span>
          )}
          <span className="vg-when">
            <b>{hm} {ampm}</b>
            {now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        </div>
      </header>

      {/* Rail */}
      <nav className="vg-rail">
        {navItems.map((n, i) => (
          <button
            key={n.id}
            type="button"
            className={nav === n.id ? 'vg-active' : ''}
            style={{ '--i': i } as CSSProperties}
            onClick={() => {
              setNav(n.id)
              n.run?.()
            }}
          >
            <Icon size={20}>{n.icon}</Icon>
            <span className="vg-tip">{n.label}</span>
          </button>
        ))}
        {/* Quick actions: open an app in one tap. */}
        <span className="vg-rail-sep" aria-hidden="true" />
        {[
          { label: 'Browser', icon: I.globe, run: () => void launch('chrome') },
          { label: 'Code', icon: I.code, run: () => void launch('code') },
          { label: 'Music', icon: I.music, run: () => void launch('spotify') },
          { label: 'Notes', icon: I.note, run: () => void launch('notepad') },
        ].map((a, k) => (
          <button key={a.label} type="button" className="vg-rail-quick" style={{ '--i': navItems.length + k } as CSSProperties} onClick={a.run}>
            <Icon size={19} w={1.6}>{a.icon}</Icon>
            <span className="vg-tip">{a.label}</span>
          </button>
        ))}
        <Me name={NAME} assistant={profile?.assistant || 'JARVIS'} />
      </nav>

      {/* Left column */}
      <div className="vg-col vg-left">
        <Panel
          title="Local Time"
          icon={I.clock}
          i={0}
          className="vg-clock"
          extra={
            <button
              type="button"
              className={`vg-cal-open ${calOpen ? 'vg-on' : ''}`}
              aria-expanded={calOpen}
              title={calOpen ? 'Hide the calendar' : 'View the calendar'}
              onClick={() => setCalOpen((v) => !v)}
            >
              <Icon size={13} w={2}>{I.calendar}</Icon>
              {calOpen ? 'Hide calendar' : 'View calendar'}
            </button>
          }
        >
          <div className="vg-clock-body">
            <svg viewBox="0 0 72 72" className="vg-sec">
              <circle cx="36" cy="36" r="30" className="vg-sec-track" />
              <circle cx="36" cy="36" r="30" className="vg-sec-fill" strokeDasharray={`${(secC * secs) / 60} ${secC}`} transform="rotate(-90 36 36)" />
              <text x="36" y="40" textAnchor="middle">{String(secs).padStart(2, '0')}</text>
            </svg>
            <div>
              <div className="vg-time">
                {hm}
                <small>{ampm}</small>
              </div>
              <div className="vg-date">{now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
            </div>
          </div>
        </Panel>

        <Panel title="Briefing" icon={I.bell} i={1} className="vg-greet">
          <h3>
            {greet}, <span>{NAME}</span>
          </h3>
          <p>Hope you're having a great day.</p>
          <div className="vg-next">
            <span className="vg-next-k">Next up</span>
            <span className="vg-next-v">
              {next
                ? `${new Date(next.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · ${next.text}`
                : 'Nothing scheduled'}
            </span>
          </div>
        </Panel>

        {/* "View calendar" shows the calendar where it always was, in place
            of Model Usage; × (or Escape, or the button again) brings it back. */}
        {calOpen ? <Calendar i={0} onClose={() => setCalOpen(false)} /> : <ModelUsage i={2} />}
      </div>

      {/* Centre */}
      <main className="vg-centre">
        <Reactor
          phase={phase}
          level={level}
          line={line}
          orb={profile?.orb ?? 'reactor'}
          title={assistantTitle(profile)}
          mini={chat}
          onExpand={closeChat}
        />
        {chat ? (
          <ChatView title={activeTitle} assistant={profile?.assistant || 'Jarvis'} onClose={closeChat} />
        ) : (
          <>
            <AgentTrace steps={trace} />
            <Conversation idle={phase === 'dormant'} />
          </>
        )}
      </main>

      {/* Right column */}
      <div className="vg-col vg-right">
        <Panel title="System Status" icon={I.pulse} i={3} className="vg-status" extra={<span className="vg-live">LIVE</span>}>
          <div className="vg-gauges">
            <Gauge label="CPU" value={s ? s.cpu : null} />
            <Gauge label="Memory" value={mem} />
            <Gauge label="GPU" value={s?.gpu ?? null} />
          </div>
          <div className="vg-meters">
            <Meter icon={I.system} label="Disk C:" value={disk} text={s?.diskFree != null ? `${s.diskFree} GB free` : '—'} />
            <Meter icon={I.battery} label="Battery" value={s?.battery ?? null} text={s?.battery != null ? `${s.battery}%${s.charging ? ' · charging' : ''}` : '—'} />
            <Meter icon={I.wifi} label="Wi-Fi" value={s?.signal ?? null} text={s?.wifi ?? 'Offline'} />
            <Meter icon={I.clock} label="Uptime" value={s ? Math.min(100, (s.uptime / 604800) * 100) : null} text={s ? uptime(s.uptime) : '—'} />
          </div>
        </Panel>

        <Sessions i={4} />

        <Panel title="Weather" icon={I.cloud} i={5} className="vg-weather" extra={<span>{w?.city ?? ''}</span>}>
          <div className="vg-wx-main">
            <WeatherArt cond={w?.cond ?? 'clear'} />
            <div>
              <div className="vg-temp">{w ? w.temp : '--'}<sup>°C</sup></div>
              <div className="vg-cond">{w?.cond ?? 'Fetching…'}</div>
            </div>
          </div>
          <div className="vg-wx-grid">
            <span>Feels<b>{w ? `${w.feels}°` : '--'}</b></span>
            <span>Humidity<b>{w ? `${w.humidity}%` : '--'}</b></span>
            <span>Wind<b>{w ? `${w.wind} km/h` : '--'}</b></span>
            <span>H / L<b>{w ? `${w.hi}° / ${w.lo}°` : '--'}</b></span>
          </div>
        </Panel>
      </div>

      <AskBar />
    </div>
  )
}
