import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { useStore } from '../store'
import './telemetry.css'

/**
 * The desktop HUD: two columns of live telemetry either side of the reactor
 * and an app dock, in the style of the classic Jarvis desktop skins.
 *
 * Everything here is real. CPU, memory, battery, Wi-Fi, disk, weather and the
 * reminder list come from the bridge's /status endpoint (polled every three
 * seconds; the slow readings are cached there). The activity feed is the
 * assistant's own phases and tool calls. Nothing is decorative noise
 * pretending to be data.
 */

type Status = {
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

function useStatus(): Status | null {
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
    const id = window.setInterval(pull, 3000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])
  return s
}

function useNow(ms: number) {
  const [now, set] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => set(new Date()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}

const pad = (n: number) => String(n).padStart(2, '0')
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/* ------------------------------------------------------------------ pieces */

/** A ring gauge: rotating tick bezel, faint track, glowing arc, content centred. */
function Ring({
  value,
  size,
  stroke = 4,
  children,
  warn = false,
  bezel = true,
}: {
  value: number
  size: number
  stroke?: number
  children?: ReactNode
  warn?: boolean
  bezel?: boolean
}) {
  const r = size / 2 - stroke - 6
  const len = 2 * Math.PI * r
  const v = clamp01(value)
  return (
    <div className={`tl-ring${warn ? ' tl-warn' : ''}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {bezel && (
          <circle
            className="tl-bezel"
            cx={size / 2}
            cy={size / 2}
            r={size / 2 - 2}
            strokeDasharray="1 5"
          />
        )}
        <circle className="tl-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle
          className="tl-arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={`${len * v} ${len}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <circle
          className="tl-inner"
          cx={size / 2}
          cy={size / 2}
          r={r - stroke - 4}
          strokeDasharray="14 6"
        />
      </svg>
      <div className="tl-ring-body">{children}</div>
    </div>
  )
}

/** A bracketed panel with a header strip, like the boxes in the reference. */
function Panel({ title, code, children }: { title: string; code?: string; children: ReactNode }) {
  return (
    <section className="tl-panel">
      <header>
        <span>{title}</span>
        {code && <span className="tl-code">{code}</span>}
      </header>
      {children}
    </section>
  )
}

function Bar({ value, warn = false }: { value: number; warn?: boolean }) {
  return (
    <div className={`tl-bar${warn ? ' tl-warn' : ''}`}>
      <div style={{ width: `${clamp01(value) * 100}%` }} />
    </div>
  )
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="tl-row">
      <span className="tl-k">{k}</span>
      <span className="tl-v">{v}</span>
    </div>
  )
}

/* ----------------------------------------------------------------- widgets */

function weekNo(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return pad(Math.ceil(((t.getTime() - y.getTime()) / 86400000 + 1) / 7))
}

function Clock() {
  const now = useNow(1000)
  const h = now.getHours()
  const h12 = h % 12 || 12
  const sec = now.getSeconds()
  const min = now.getMinutes()
  return (
    <div className="tl-clock">
      <Ring value={sec / 60} size={150} stroke={3}>
        <Ring value={min / 60} size={104} stroke={5} bezel={false}>
          <div className="tl-hour">{pad(h12)}</div>
          <div className="tl-min">
            :{pad(min)} <small>{h < 12 ? 'AM' : 'PM'}</small>
          </div>
        </Ring>
      </Ring>
      <div className="tl-date">
        <div className="tl-day">{now.toLocaleDateString('en-IN', { weekday: 'long' })}</div>
        <div className="tl-dmy">
          {now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
        </div>
        <div className="tl-secs">
          {pad(h)}
          {pad(min)}
          {pad(sec)} · WK {weekNo(now)}
        </div>
      </div>
    </div>
  )
}

function upFor(s: number) {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}D ${pad(h)}H` : `${pad(h)}H ${pad(m)}M`
}

function Core({ s }: { s: Status | null }) {
  const mem = s ? s.memUsed / s.memTotal : 0
  const disk = s?.diskFree != null && s.diskTotal ? 1 - s.diskFree / s.diskTotal : 0
  return (
    <Panel title="Core systems" code={s ? `${s.cores} CORE` : '--'}>
      <div className="tl-pair">
        <Ring value={(s?.cpu ?? 0) / 100} size={88} warn={(s?.cpu ?? 0) > 85}>
          <div className="tl-num">
            {s ? s.cpu : '--'}
            <small>%</small>
          </div>
          <div className="tl-cap">CPU</div>
        </Ring>
        <Ring value={mem} size={88} warn={mem > 0.9}>
          <div className="tl-num">
            {s ? Math.round(mem * 100) : '--'}
            <small>%</small>
          </div>
          <div className="tl-cap">RAM</div>
        </Ring>
      </div>
      <Row k="Memory" v={s ? `${s.memUsed} / ${s.memTotal} GB` : '--'} />
      <Row k="Drive C" v={s?.diskFree != null ? `${s.diskFree} GB free` : '--'} />
      <Bar value={disk} warn={disk > 0.92} />
      <Row k="Uptime" v={s ? upFor(s.uptime) : '--'} />
      <Row k="Host" v={s ? s.host : '--'} />
    </Panel>
  )
}

function Linked() {
  const connected = useStore((st) => st.connected)
  const short = (c: string) => c.replace(/^claude\.ai\s+/i, '').replace(/^jarvis_?/i, '') || 'core'
  return (
    <Panel title="Linked systems" code={pad(connected.length)}>
      <div className="tl-links">
        {connected.length === 0 && <span className="tl-dim">none linked</span>}
        {connected.slice(0, 12).map((c) => (
          <span key={c} className="tl-link">
            <i />
            {short(c)}
          </span>
        ))}
      </div>
    </Panel>
  )
}

function Weather({ s }: { s: Status | null }) {
  const w = s?.weather
  // The ring shows where the temperature sits in today's range.
  const span = w ? Math.max(1, w.hi - w.lo) : 1
  return (
    <div className="tl-weather">
      <Ring value={w ? (w.temp - w.lo) / span : 0} size={132} stroke={3}>
        <div className="tl-temp">
          {w ? w.temp : '--'}
          <sup>°</sup>
        </div>
        <div className="tl-cap">{w ? w.cond : 'weather'}</div>
      </Ring>
      <div className="tl-wx">
        <div className="tl-city">{w ? w.city : 'Locating'}</div>
        <Row k="Feels" v={w ? `${w.feels}°C` : '--'} />
        <Row k="Hi/Lo" v={w ? `${w.hi}°/${w.lo}°` : '--'} />
        <Row k="Humidity" v={w ? `${w.humidity}%` : '--'} />
        <Row k="Rain" v={w ? `${w.rain}%` : '--'} />
        <Row k="Wind" v={w ? `${w.wind} km/h` : '--'} />
      </div>
    </div>
  )
}

function Power({ s }: { s: Status | null }) {
  const level = useStore((st) => st.level)
  const bat = s?.battery
  return (
    <Panel title="Power & network" code={s?.charging ? 'AC' : 'BAT'}>
      <div className="tl-pair">
        <Ring value={(bat ?? 100) / 100} size={88} warn={bat != null && bat < 20 && !s?.charging}>
          <div className="tl-num">
            {bat ?? 'AC'}
            {bat != null && <small>%</small>}
          </div>
          <div className="tl-cap">{s?.charging ? 'Charging' : 'Battery'}</div>
        </Ring>
        <Ring value={(s?.signal ?? 0) / 100} size={88}>
          <div className="tl-num">
            {s?.signal ?? '--'}
            <small>%</small>
          </div>
          <div className="tl-cap">Wi-Fi</div>
        </Ring>
      </div>
      <Row k="Network" v={s?.wifi ?? 'offline'} />
      <Row k="Voice in" v={`${Math.round(level * 100)}%`} />
      <Bar value={level} />
    </Panel>
  )
}

function Schedule({ s }: { s: Status | null }) {
  const list = s?.reminders ?? []
  return (
    <Panel title="Schedule" code={pad(list.length)}>
      {list.length === 0 && <div className="tl-dim">No pending tasks</div>}
      {list.map((r, i) => {
        const at = new Date(r.at)
        const today = at.toDateString() === new Date().toDateString()
        return (
          <div key={i} className="tl-task">
            <span className="tl-when">
              {today ? '' : at.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' '}
              {at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}
            </span>
            <span className="tl-what">
              {r.text}
              {r.repeat ? ` · ${r.repeat}` : ''}
            </span>
          </div>
        )
      })}
    </Panel>
  )
}

/** The assistant's own activity: phases and tools, newest first. */
function Activity() {
  const [lines, setLines] = useState<{ t: string; m: string }[]>([])
  const last = useRef('')
  useEffect(() => {
    const push = (m: string) => {
      if (!m || m === last.current) return
      last.current = m
      const d = new Date()
      setLines((l) =>
        [{ t: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, m }, ...l].slice(0, 5),
      )
    }
    push('SYSTEMS NOMINAL')
    return useStore.subscribe((st, prev) => {
      if (st.activeTool && st.activeTool !== prev.activeTool) {
        push(`EXEC ${st.activeTool.replace(/^mcp__/, '').replace(/__/g, '.').replace(/[_-]/g, ' ')}`)
      }
      if (st.phase !== prev.phase && ['listening', 'thinking', 'speaking', 'dormant'].includes(st.phase)) {
        push(st.phase === 'dormant' ? 'STANDBY' : st.phase.toUpperCase())
      }
    })
  }, [])
  return (
    <Panel title="Activity" code="LOG">
      <div className="tl-feed">
        {lines.map((l, i) => (
          <div key={`${l.t}${i}`} className="tl-feed-line" style={{ opacity: 1 - i * 0.12 }}>
            <span>{l.t}</span>
            {l.m}
          </div>
        ))}
      </div>
    </Panel>
  )
}

/* -------------------------------------------------------------------- dock */

const DOCK: { id: string; label: string; icon: ReactNode }[] = [
  {
    id: 'chrome',
    label: 'Web',
    icon: (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3" />
        <path d="M12 9h7M9.5 13.5 6 19M14.5 13.5 18 19" />
      </>
    ),
  },
  { id: 'files', label: 'Files', icon: <path d="M3 7h6l2 2h10v10H3z" /> },
  {
    id: 'whatsapp',
    label: 'Chat',
    icon: (
      <>
        <path d="M5 19l1.5-4A7 7 0 1 1 9 18z" />
        <path d="M9.5 10c.5 2 2 3.5 4 4" />
      </>
    ),
  },
  { id: 'code', label: 'Code', icon: <path d="M9 7 4 12l5 5M15 7l5 5-5 5" /> },
  {
    id: 'spotify',
    label: 'Music',
    icon: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M8 10c3-1 6-.5 8 1M8.5 13c2.5-.7 5-.3 6.5.8" />
      </>
    ),
  },
  {
    id: 'terminal',
    label: 'Shell',
    icon: (
      <>
        <rect x="3" y="5" width="18" height="14" />
        <path d="m7 10 3 2-3 2M12 15h5" />
      </>
    ),
  },
  {
    id: 'settings',
    label: 'Config',
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      </>
    ),
  },
]

function Dock() {
  const [busy, setBusy] = useState('')
  const open = async (id: string) => {
    setBusy(id)
    try {
      await fetch(`${BRIDGE_HTTP_URL}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: id }),
      })
    } catch {
      /* bridge down */
    } finally {
      window.setTimeout(() => setBusy(''), 900)
    }
  }
  return (
    <nav className="tl-dock" aria-label="Launch">
      {DOCK.map((d) => (
        <button
          key={d.id}
          type="button"
          className={busy === d.id ? 'tl-busy' : ''}
          onClick={() => void open(d.id)}
          title={d.label}
        >
          <svg viewBox="0 0 24 24" width="20" height="20">
            {d.icon}
          </svg>
          <span>{d.label}</span>
        </button>
      ))}
    </nav>
  )
}

/* -------------------------------------------------------------------- hud */

export function Telemetry() {
  const s = useStatus()
  return (
    <>
      <div className="tl-col tl-left">
        <Clock />
        <Core s={s} />
        <Linked />
      </div>
      <div className="tl-col tl-right">
        <Weather s={s} />
        <Power s={s} />
        <Schedule s={s} />
        <Activity />
      </div>
      <Dock />
    </>
  )
}
