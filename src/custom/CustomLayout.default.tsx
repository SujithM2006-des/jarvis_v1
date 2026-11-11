import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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
} from './kit'
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
const HIDE: StockPart[] = ['frame', 'header', 'telemetry', 'dock', 'suggestions', 'scene', 'scanlines', 'caption', 'hints', 'transcript', 'error']


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
function Calendar({ i }: { i: number }) {
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
        <button type="button" className="vg-icon-btn" title="Add an event" onClick={() => (adding ? setAdding(false) : openAdd())}>
          <Icon size={14} w={2}>{adding ? I.close : I.plus}</Icon>
        </button>
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

/** The reactor: layered rings, live to his phase. */
function Reactor({ phase, level, line }: { phase: JarvisPhase; level: number; line: string }) {
  const voiced = phase === 'speaking' || phase === 'listening' || phase === 'waking'
  return (
    <div className={`vg-reactor vg-ph-${phase}`}>
      <div className="vg-halo" />
      <svg viewBox="0 0 400 400" className="vg-r-svg">
        <defs>
          <linearGradient id="vg-ring-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--hi)" />
            <stop offset="0.5" stopColor="var(--core)" />
            <stop offset="1" stopColor="var(--deep)" />
          </linearGradient>
          <radialGradient id="vg-disk-g" cx="50%" cy="40%" r="62%">
            <stop offset="0" stopColor="#0f2f66" />
            <stop offset="0.6" stopColor="#051330" />
            <stop offset="1" stopColor="#020a1a" />
          </radialGradient>
          <path id="vg-orbit-path" d="M200,200 m-208,0 a208,208 0 1,1 416,0 a208,208 0 1,1 -416,0" />
        </defs>
        {/* An orbiting legend, slowly turning — the core's own readout. */}
        <g className="vg-spin-text">
          <text className="vg-orbit-text">
            <textPath href="#vg-orbit-path">
              {`J.A.R.V.I.S  ·  NEURAL CORE  ·  ${(phaseLabel[phase] ?? 'Online').toUpperCase()}  ·  VOICE LINK  ·  J.A.R.V.I.S  ·  NEURAL CORE  ·  ${(phaseLabel[phase] ?? 'Online').toUpperCase()}  ·  VOICE LINK  ·`}
            </textPath>
          </text>
        </g>
        <g className="vg-spin-slow">
          {Array.from({ length: 90 }, (_, i) => {
            const a = (i / 90) * Math.PI * 2
            const long = i % 15 === 0
            return (
              <line
                key={i}
                x1={200 + Math.cos(a) * 196}
                y1={200 + Math.sin(a) * 196}
                x2={200 + Math.cos(a) * (long ? 184 : 190)}
                y2={200 + Math.sin(a) * (long ? 184 : 190)}
                className={long ? 'vg-tick-l' : 'vg-tick'}
              />
            )
          })}
        </g>
        <g className="vg-spin-a"><circle cx="200" cy="200" r="176" className="vg-seg" strokeDasharray="120 30 20 30 70 50" /></g>
        <g className="vg-spin-b"><circle cx="200" cy="200" r="166" className="vg-dots" strokeDasharray="1.5 9" /></g>
        <circle cx="200" cy="200" r="150" className="vg-ring-bloom" />
        <circle cx="200" cy="200" r="150" className="vg-ring" />
        <g className="vg-spin-c"><circle cx="200" cy="200" r="150" className="vg-ring-hot" strokeDasharray="70 873" /></g>
        <circle cx="200" cy="200" r="136" className="vg-ring-in" />
        <circle cx="200" cy="200" r="128" fill="url(#vg-disk-g)" />
        <g className="vg-spin-d"><circle cx="200" cy="200" r="120" className="vg-inner-dash" strokeDasharray="30 12" /></g>
      </svg>
      <div className="vg-r-text">
        <span className="vg-r-kicker">{phaseLabel[phase] ?? 'Online'}</span>
        <h1>J.A.R.V.I.S.</h1>
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
                  <span className="vg-said">{t.text}</span>
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

function AskBar() {
  const { phase, level, caption, error } = useJarvis()
  const muted = useMuted()
  const [text, setText] = useState('')
  const listening = !muted && (phase === 'listening' || phase === 'waking')
  const send = () => {
    if (!text.trim()) return
    void ask(text)
    setText('')
  }
  return (
    <div className={`vg-ask ${listening ? 'vg-live' : ''}`}>
      {error && <div className="vg-ask-error" role="alert">{error}</div>}
      <Wave level={listening ? level : 0} bars={7} idle={listening ? 0.45 : 0.3} className="vg-ask-wave" />
      <input
        value={text}
        placeholder={muted ? 'Microphone muted — type here, or tap the mic to unmute' : listening ? caption || 'Listening…' : 'Ask me anything…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && send()}
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

  const navItems = [
    { id: 'home', label: 'Home', icon: I.home },
    { id: 'apps', label: 'Apps', icon: I.apps, run: () => void ask('Which apps are open right now?') },
    { id: 'files', label: 'Files', icon: I.files, run: () => void launch('files') },
    { id: 'system', label: 'System', icon: I.system, run: () => void ask("How's my laptop doing?") },
    { id: 'settings', label: 'Settings', icon: I.settings, run: () => void launch('settings') },
    { id: 'assistant', label: 'Assistant', icon: I.assistant, run: () => void openPopup() },
  ]

  const secC = 2 * Math.PI * 30

  return (
    <div className={`vg-root vg-ph-${phase}`}>
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
          <strong>J.A.R.V.I.S.</strong>
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
        <span className="vg-avatar" title={NAME}>{NAME[0].toUpperCase()}</span>
      </nav>

      {/* Left column */}
      <div className="vg-col vg-left">
        <Panel title="Local Time" icon={I.clock} i={0} className="vg-clock">
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

        <Calendar i={2} />
      </div>

      {/* Centre */}
      <main className="vg-centre">
        <Reactor phase={phase} level={level} line={line} />
        <AgentTrace steps={trace} />
        <Conversation idle={phase === 'dormant'} />
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

        <Panel title="Quick Actions" icon={I.bolt} i={4} className="vg-actions">
          <div className="vg-action-grid">
            {[
              { label: 'Browser', icon: I.globe, run: () => void launch('chrome') },
              { label: 'Code', icon: I.code, run: () => void launch('code') },
              { label: 'Music', icon: I.music, run: () => void launch('spotify') },
              { label: 'Notes', icon: I.note, run: () => void launch('notepad') },
            ].map((a) => (
              <button key={a.label} type="button" onClick={a.run}>
                <Icon size={20} w={1.5}>{a.icon}</Icon>
                <span>{a.label}</span>
              </button>
            ))}
          </div>
        </Panel>

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
