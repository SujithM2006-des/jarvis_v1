import { useId, useMemo, type CSSProperties } from 'react'
import type { JarvisPhase } from './kit'
import './orbs.css'

/**
 * The centre orb, in five designs, chosen in setup ("Customize"). Each is one
 * SVG on a 400×400 board, coloured from the layout's --core / --hi / --deep (so
 * it follows the colour theme and his phase), and moved by CSS — nothing
 * re-renders per frame except what follows his voice level.
 *
 *   reactor  the arc reactor: layered rings and a turning legend
 *   atom     a bright core inside tilted orbits, sparks and broken arcs
 *   nebula   a sphere of particles streaming along tilted orbits
 *   pulse    a ring of bars that rise with his voice
 *   prism    turning hexagonal shields around a calm centre
 */

export type OrbId = 'reactor' | 'atom' | 'nebula' | 'pulse' | 'prism'

export const ORBS: { id: OrbId; label: string; textBelow: boolean }[] = [
  { id: 'reactor', label: 'Arc Reactor', textBelow: false },
  { id: 'atom', label: 'Atom', textBelow: true },
  { id: 'nebula', label: 'Nebula', textBelow: true },
  { id: 'pulse', label: 'Pulse', textBelow: false },
  { id: 'prism', label: 'Prism', textBelow: false },
]

export const orbInfo = (id: string | undefined) => ORBS.find((o) => o.id === id) ?? ORBS[0]

/** Seeded random, so the sparks sit in the same places on every render. */
function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Props = {
  id: string | undefined
  phase: JarvisPhase
  /** Voice level, 0–1. */
  level: number
  /** The reactor's turning legend. */
  legend?: string
  className?: string
}

export function Orb({ id, phase, level, legend = '', className = '' }: Props) {
  const o = orbInfo(id)
  const voiced = phase === 'speaking' || phase === 'listening' || phase === 'waking'
  const lv = voiced ? Math.min(1, level) : 0
  return (
    <svg
      viewBox="0 0 400 400"
      className={`orb orb-${o.id} orb-ph-${phase} ${className}`}
      style={{ '--lv': lv.toFixed(3) } as CSSProperties}
      aria-hidden="true"
    >
      {o.id === 'reactor' && <Reactor legend={legend} />}
      {o.id === 'atom' && <Atom />}
      {o.id === 'nebula' && <Nebula />}
      {o.id === 'pulse' && <Pulse lv={lv} />}
      {o.id === 'prism' && <Prism />}
    </svg>
  )
}

// ------------------------------------------------------------------ reactor

function Reactor({ legend }: { legend: string }) {
  const u = useId().replace(/:/g, '')
  return (
    <>
      <defs>
        <radialGradient id={`${u}d`} cx="50%" cy="40%" r="62%">
          <stop offset="0" stopColor="#0f2f66" />
          <stop offset="0.6" stopColor="#051330" />
          <stop offset="1" stopColor="#020a1a" />
        </radialGradient>
        <path id={`${u}p`} d="M200,200 m-208,0 a208,208 0 1,1 416,0 a208,208 0 1,1 -416,0" />
      </defs>
      {legend && (
        <g className="vg-spin-text">
          <text className="vg-orbit-text">
            <textPath href={`#${u}p`}>{legend}</textPath>
          </text>
        </g>
      )}
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
      <circle cx="200" cy="200" r="128" fill={`url(#${u}d)`} />
      <g className="vg-spin-d"><circle cx="200" cy="200" r="120" className="vg-inner-dash" strokeDasharray="30 12" /></g>
    </>
  )
}

// --------------------------------------------------------------------- atom

function Atom() {
  const u = useId().replace(/:/g, '')
  const sparks = useMemo(() => {
    const r = seeded(7)
    return Array.from({ length: 110 }, () => {
      const a = r() * Math.PI * 2
      const d = Math.sqrt(r()) * 172
      return { x: 200 + Math.cos(a) * d, y: 200 + Math.sin(a) * d, s: 0.6 + r() * 2.2, t: (r() * 4).toFixed(2), o: 0.35 + r() * 0.65 }
    })
  }, [])
  const rays = useMemo(() => {
    const r = seeded(11)
    return Array.from({ length: 28 }, () => r() * Math.PI * 2)
  }, [])
  return (
    <>
      <defs>
        <radialGradient id={`${u}c`} cx="50%" cy="45%" r="50%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.35" stopColor="var(--hi)" stopOpacity="0.95" />
          <stop offset="0.75" stopColor="var(--core)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--core)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${u}g`}>
          <stop offset="0" stopColor="var(--core)" stopOpacity="0.45" />
          <stop offset="1" stopColor="var(--core)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="200" cy="200" r="190" fill={`url(#${u}g)`} className="orb-breathe" />
      {/* Broken outer arcs, turning both ways. */}
      <g className="orb-spin orb-s60">
        <circle cx="200" cy="200" r="188" className="orb-arc" strokeDasharray="240 60 150 90 300 341" />
      </g>
      <g className="orb-spin orb-s90 orb-rev">
        <circle cx="200" cy="200" r="176" className="orb-thin" strokeDasharray="3 6" />
      </g>
      {/* Faint rays from the core. */}
      <g className="orb-rays">
        {rays.map((a, i) => (
          <line key={i} x1="200" y1="200" x2={200 + Math.cos(a) * 170} y2={200 + Math.sin(a) * 170} />
        ))}
      </g>
      {/* Tilted orbits: a soft ribbon, and a bright runner moving along it. */}
      {[
        { rx: 168, ry: 58, rot: -18, d: '9s' },
        { rx: 160, ry: 46, rot: 62, d: '11s' },
        { rx: 150, ry: 40, rot: 112, d: '13s' },
      ].map((e, i) => (
        <g key={i} transform={`rotate(${e.rot} 200 200)`}>
          <ellipse cx="200" cy="200" rx={e.rx} ry={e.ry} className="orb-ribbon" />
          <ellipse cx="200" cy="200" rx={e.rx} ry={e.ry} className="orb-runner" style={{ animationDuration: e.d } as CSSProperties} />
        </g>
      ))}
      {/* Inner ring round the core. */}
      <ellipse cx="200" cy="200" rx="82" ry="70" className="orb-inner" />
      <g className="orb-spin orb-s20">
        <ellipse cx="200" cy="200" rx="82" ry="70" className="orb-inner-hot" strokeDasharray="60 420" />
      </g>
      {/* Sparks. */}
      <g>
        {sparks.map((s, i) => (
          <circle key={i} cx={s.x} cy={s.y} r={s.s} className="orb-spark" style={{ animationDelay: `-${s.t}s`, opacity: s.o } as CSSProperties} />
        ))}
      </g>
      {/* The core: a glass sphere and a white heart that swells with his voice. */}
      <g className="orb-core">
        <circle cx="200" cy="200" r="46" fill={`url(#${u}c)`} />
        <circle cx="200" cy="200" r="46" className="orb-glass" />
        <circle cx="200" cy="200" r="15" fill="#f4fdff" className="orb-heart" />
      </g>
    </>
  )
}

// ------------------------------------------------------------------- nebula

function Nebula() {
  const u = useId().replace(/:/g, '')
  const orbits = [
    { r: 165, tilt: 0.28, rot: -25, d: '18s', w: 3.2 },
    { r: 150, tilt: 0.55, rot: 40, d: '14s', w: 2.6 },
    { r: 138, tilt: 0.85, rot: 95, d: '22s', w: 2.4 },
    { r: 120, tilt: 0.4, rot: 150, d: '12s', w: 2.2 },
    { r: 100, tilt: 0.7, rot: 15, d: '16s', w: 2 },
    { r: 80, tilt: 0.3, rot: 70, d: '10s', w: 1.8 },
  ]
  return (
    <>
      <defs>
        <radialGradient id={`${u}n`}>
          <stop offset="0" stopColor="var(--hi)" stopOpacity="0.9" />
          <stop offset="0.3" stopColor="var(--core)" stopOpacity="0.5" />
          <stop offset="1" stopColor="var(--deep)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="200" cy="200" r="182" className="orb-shell" />
      <circle cx="200" cy="200" r="120" fill={`url(#${u}n)`} className="orb-breathe" />
      {orbits.map((o, i) => (
        <g key={i} transform={`rotate(${o.rot} 200 200)`}>
          <ellipse cx="200" cy="200" rx={o.r} ry={o.r * o.tilt} className="orb-trail" />
          <ellipse
            cx="200"
            cy="200"
            rx={o.r}
            ry={o.r * o.tilt}
            className="orb-stream"
            strokeWidth={o.w}
            style={{ animationDuration: o.d, animationDirection: i % 2 ? 'reverse' : 'normal' } as CSSProperties}
          />
        </g>
      ))}
      <g className="orb-core">
        <circle cx="200" cy="200" r="10" fill="#f4fdff" className="orb-heart" />
      </g>
    </>
  )
}

// -------------------------------------------------------------------- pulse

function Pulse({ lv }: { lv: number }) {
  const u = useId().replace(/:/g, '')
  const N = 72
  return (
    <>
      <defs>
        <radialGradient id={`${u}p`} cx="50%" cy="40%" r="62%">
          <stop offset="0" stopColor="#0f2f66" />
          <stop offset="0.7" stopColor="#041027" />
          <stop offset="1" stopColor="#020a1a" />
        </radialGradient>
      </defs>
      <g className="orb-spin orb-s120">
        <circle cx="200" cy="200" r="190" className="orb-thin" strokeDasharray="2 8" />
      </g>
      {/* Bars rise with his voice (scale) and idle gently (animation). */}
      <g className="orb-bars" style={{ transform: `scale(${1 + lv * 0.18})` } as CSSProperties}>
        {Array.from({ length: N }, (_, i) => (
          <g key={i} transform={`rotate(${(i / N) * 360} 200 200)`}>
            <rect
              x="198"
              y={200 - 178}
              width="4"
              height="40"
              rx="2"
              className="orb-bar"
              style={{ animationDelay: `-${((i * 7) % N) / 18}s`, '--amp': (0.35 + lv * 1.4).toFixed(2) } as CSSProperties}
            />
          </g>
        ))}
      </g>
      <circle cx="200" cy="200" r="132" className="orb-ring" />
      <g className="orb-spin orb-s20">
        <circle cx="200" cy="200" r="132" className="orb-ring-hot" strokeDasharray="90 740" />
      </g>
      <circle cx="200" cy="200" r="124" fill={`url(#${u}p)`} />
      <g className="orb-spin orb-s40 orb-rev">
        <circle cx="200" cy="200" r="114" className="orb-thin" strokeDasharray="24 10" />
      </g>
    </>
  )
}

// -------------------------------------------------------------------- prism

const hex = (r: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2
    return `${(200 + Math.cos(a) * r).toFixed(1)},${(200 + Math.sin(a) * r).toFixed(1)}`
  }).join(' ')

function Prism() {
  const u = useId().replace(/:/g, '')
  return (
    <>
      <defs>
        <radialGradient id={`${u}h`} cx="50%" cy="40%" r="62%">
          <stop offset="0" stopColor="#0f2f66" />
          <stop offset="0.7" stopColor="#041027" />
          <stop offset="1" stopColor="#020a1a" />
        </radialGradient>
      </defs>
      <g className="orb-spin orb-s60">
        <polygon points={hex(188)} className="orb-hex-a" />
        {Array.from({ length: 6 }, (_, i) => {
          const a = (Math.PI / 3) * i - Math.PI / 2
          return <circle key={i} cx={200 + Math.cos(a) * 188} cy={200 + Math.sin(a) * 188} r="4" className="orb-node" />
        })}
      </g>
      <g className="orb-spin orb-s40 orb-rev">
        <polygon points={hex(166)} className="orb-hex-b" strokeDasharray="40 14" />
      </g>
      <g className="orb-spin orb-s90">
        {/* A triangle grid between the shields. */}
        <polygon points={hex(150)} className="orb-hex-c" />
        {Array.from({ length: 3 }, (_, i) => {
          const a = (Math.PI / 3) * i - Math.PI / 2
          return (
            <line
              key={i}
              x1={200 + Math.cos(a) * 150}
              y1={200 + Math.sin(a) * 150}
              x2={200 - Math.cos(a) * 150}
              y2={200 - Math.sin(a) * 150}
              className="orb-grid"
            />
          )
        })}
      </g>
      <polygon points={hex(132)} className="orb-hex-glow" />
      <polygon points={hex(132)} className="orb-hex-main" />
      <polygon points={hex(124)} fill={`url(#${u}h)`} />
      <g className="orb-spin orb-s30 orb-rev">
        <polygon points={hex(112)} className="orb-hex-b" strokeDasharray="10 8" />
      </g>
    </>
  )
}
