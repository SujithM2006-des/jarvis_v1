import { useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { currentRate, currentVoiceName, listVoices, previewVoice, setVoiceProfile } from '../lib/tts'
import { assistantTitle, refreshProfile, useProfile, type Profile } from '../custom/kit'
import { ORBS, Orb } from '../custom/orbs'
import './setup.css'

/**
 * Setup: who this copy of JARVIS works for, and how it looks and sounds.
 *
 * Opens by itself the first time (no ~/.jarvis/profile.json yet), and again
 * from the sidebar's Profile button. The creator line at the bottom comes from
 * the bridge, where it is fixed in the code — it is not a setting.
 */

/**
 * The interface's blue turned by `deg`, with the same matrix as CSS
 * hue-rotate() — so each swatch shows exactly the colour the interface (and
 * the popup, which uses the same maths) will take.
 */
function turned(hex: string, deg: number) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return (
    '#' +
    ch(r * (0.213 + c * 0.787 - s * 0.213) + g * (0.715 - c * 0.715 - s * 0.715) + b * (0.072 - c * 0.072 + s * 0.928)) +
    ch(r * (0.213 - c * 0.213 + s * 0.143) + g * (0.715 + c * 0.285 + s * 0.14) + b * (0.072 - c * 0.072 - s * 0.283)) +
    ch(r * (0.213 - c * 0.213 - s * 0.787) + g * (0.715 - c * 0.715 + s * 0.715) + b * (0.072 + c * 0.928 + s * 0.072))
  )
}

// In hue order round the wheel. Hues must match bridge/profile.mjs and
// scripts/popup.ps1.
const THEMES: { id: string; label: string; hue: number; swatch: string }[] = [
  ['blue', 'Blue', 0],
  ['indigo', 'Indigo', 30],
  ['purple', 'Purple', 70],
  ['magenta', 'Magenta', 115],
  ['crimson', 'Crimson', 150],
  ['orange', 'Orange', 180],
  ['amber', 'Amber', 200],
  ['yellow', 'Yellow', 220],
  ['lime', 'Lime', -110],
  ['green', 'Green', -60],
  ['teal', 'Teal', -25],
].map(([id, label, hue]) => ({ id: id as string, label: label as string, hue: hue as number, swatch: turned('#3fb6ff', hue as number) }))

/** From the bridge's /accounts: connected or not (null: still checking), and sign-ins in progress. */
type Accounts = Record<'gemini' | 'groq' | 'openrouter' | 'chatgpt', { connected: boolean | null }> & {
  running: boolean
  jobs: Record<string, { state: string; note: string }>
}

/** The AI accounts in setup: sign in once, JARVIS sets up the rest. `key`: it gets a key (can be disconnected). */
const ACCOUNTS: { id: 'gemini' | 'groq' | 'openrouter' | 'chatgpt'; label: string; what: string; key: boolean }[] = [
  { id: 'gemini', label: 'Gemini', what: 'Google — also AI videos in the Gemini app and Google Flow', key: true },
  { id: 'groq', label: 'Groq', what: 'Free, very fast answers', key: true },
  { id: 'openrouter', label: 'OpenRouter', what: 'Free models from many makers', key: true },
  { id: 'chatgpt', label: 'ChatGPT', what: 'Pictures of your story characters (Disconnect to switch accounts)', key: true },
]

const FEATURES: { id: string; label: string; note: string }[] = [
  { id: 'pc', label: 'PC control', note: 'Open apps, manage files, run commands' },
  { id: 'browser', label: 'Browser', note: 'Read and act in your Chrome' },
  { id: 'whatsapp', label: 'WhatsApp', note: 'Send messages and files' },
  { id: 'camera', label: 'Camera', note: 'See through your webcam when asked' },
]

/** The interface colour: a hue turn from the stock blue (none for blue). */
function applyTheme(id: string | undefined) {
  const hue = THEMES.find((t) => t.id === id)?.hue ?? 0
  const root = document.documentElement
  if (hue) {
    root.style.setProperty('--theme-hue', `${hue}deg`)
    root.dataset.themeHue = '1'
  } else {
    root.style.removeProperty('--theme-hue')
    delete root.dataset.themeHue
  }
}

export function Setup() {
  const profile = useProfile()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Profile | null>(null)
  const [voice, setVoice] = useState('')
  const [rate, setRate] = useState(1)
  // AI provider keys: what is saved (masked, "••••1234") and what was typed
  // here (a new key, or null to remove one). Never shown in full.
  // Which AI accounts are connected (and any sign-in in progress).
  const [accounts, setAccounts] = useState<Accounts | null>(null)
  /** The account being disconnected right now ('' when none). */
  const [leaving, setLeaving] = useState('')
  const [keyInput, setKeyInput] = useState<Record<string, string | null>>({})
  const [voices, setVoices] = useState<{ name: string; lang: string }[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState('')

  // First run: open by itself. Always: keep the chosen colour applied.
  useEffect(() => {
    if (!profile) return
    applyTheme(profile.theme)
    // The window's title (title bar, taskbar) is the assistant's name too. The
    // popup and scripts find this window by it (they read the same profile).
    document.title = assistantTitle(profile)
    if (!profile.configured) setOpen(true)
  }, [profile])

  useEffect(() => {
    const f = () => setOpen(true)
    window.addEventListener('jarvis-setup', f)
    return () => window.removeEventListener('jarvis-setup', f)
  }, [])

  // Fresh copy of the profile each time the screen opens.
  useEffect(() => {
    if (open && profile) {
      setForm({ ...profile, features: { ...profile.features } })
      setVoice('')
      setRate(Math.round(currentRate() * 20) / 20)
      setKeyInput({})
      // The keys first (quick), then ChatGPT's sign-in too (a few seconds).
      fetch(`${BRIDGE_HTTP_URL}/accounts`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((a) => a && setAccounts(a))
        .catch(() => {})
      fetch(`${BRIDGE_HTTP_URL}/accounts?check=1`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((a) => a && setAccounts(a))
        .catch(() => {})
      setError('')
      setSaving('')
    }
  }, [open, profile])

  // The system voices arrive asynchronously in Chrome.
  useEffect(() => {
    if (!open) return
    const load = () => setVoices(listVoices())
    load()
    speechSynthesis.addEventListener('voiceschanged', load)
    return () => speechSynthesis.removeEventListener('voiceschanged', load)
  }, [open])

  if (!open || !form) return null
  const firstRun = !profile?.configured

  // The account list: "Sign in" runs the sign-in in JARVIS's window (the
  // bridge fetches the key itself); its progress shows until it is done.
  const loadAccounts = async (check = false) => {
    try {
      const r = await fetch(`${BRIDGE_HTTP_URL}/accounts${check ? '?check=1' : ''}`, { cache: 'no-store' })
      if (r.ok) setAccounts(await r.json())
    } catch {
      /* JARVIS not running: the list stays as it was */
    }
  }
  const signIn = async (id: string) => {
    try {
      await fetch(`${BRIDGE_HTTP_URL}/keys/auto`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providers: [id] }),
      })
    } catch {
      setError('JARVIS is not running, so that sign-in could not start.')
      return
    }
    await loadAccounts()
    const poll = window.setInterval(async () => {
      try {
        const s = await (await fetch(`${BRIDGE_HTTP_URL}/accounts`, { cache: 'no-store' })).json()
        setAccounts(s)
        if (!s.running) window.clearInterval(poll)
      } catch {
        /* try again next tick */
      }
    }, 2000)
  }
  // Disconnect: a key is removed; ChatGPT is signed out in JARVIS's window
  // (so another account can be signed in).
  const disconnect = async (id: string) => {
    setLeaving(id)
    if (id === 'chatgpt') {
      await fetch(`${BRIDGE_HTTP_URL}/accounts/chatgpt/logout`, { method: 'POST' }).catch(() => {})
    } else {
      await fetch(`${BRIDGE_HTTP_URL}/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [id]: null }),
      }).catch(() => {})
    }
    await loadAccounts()
    setLeaving('')
  }
  const set = (patch: Partial<Profile>) => setForm({ ...form, ...patch })

  // The same sentence for every voice, so they can be compared fairly.
  const sample = `Hello! I'm ${form.assistant.trim() || 'JARVIS'}, your personal assistant. How can I help you today?`
  const current = currentVoiceName()

  // Skip: keep the defaults. It still counts as set up, so this screen does
  // not come back by itself; the sidebar's Profile button reopens it.
  const save = async (skip = false) => {
    setError('')
    if (!skip && !form.name.trim()) return setError('Please enter your name — or skip for now.')
    speechSynthesis.cancel()
    setSaving('Saving…')
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(skip ? { ...form, skip: true } : form),
      })
      const body = await res.json()
      if (!res.ok) {
        setSaving('')
        return setError(String(body.error ?? 'Could not save.'))
      }
      if (!skip) setVoiceProfile({ voice: voice || null, rate })
      // Keys typed here (or removed): saved on this PC only.
      const typed = Object.fromEntries(Object.entries(keyInput).filter(([, v]) => v === null || (v ?? '').trim()))
      if (!skip && Object.keys(typed).length) {
        setSaving('Saving the AI keys and starting the translator…')
        await fetch(`${BRIDGE_HTTP_URL}/keys`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(typed),
        }).catch(() => {})
      }
      applyTheme(body.theme)
      refreshProfile()
      if (body.restarting) {
        setSaving('Turning features on and off — back in a few seconds…')
        window.setTimeout(() => setOpen(false), 3500)
      } else {
        setOpen(false)
      }
    } catch {
      setSaving('')
      setError('JARVIS is not running, so this could not be saved.')
    }
  }

  return (
    <div className="su-backdrop" role="dialog" aria-modal="true" aria-labelledby="su-title">
      <div className="su-card">
        <header className="su-head">
          <div className="su-ring" aria-hidden="true"><i /></div>
          <div>
            <h2 id="su-title">{firstRun ? 'Welcome — let’s set you up' : `Customize ${profile?.assistant || 'JARVIS'}`}</h2>
            <p>{firstRun ? 'A few details so your assistant knows who it works for.' : 'Change any of this whenever you like.'}</p>
          </div>
        </header>

        <div className="su-body">
          <div className="su-row2">
            <label className="su-field">
              <span>Your name</span>
              <input value={form.name} maxLength={40} autoFocus placeholder="What should it call you?" onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="su-field">
              <span>Your city</span>
              <input value={form.city} maxLength={60} placeholder="For weather when location is off" onChange={(e) => set({ city: e.target.value })} />
            </label>
          </div>

          <div className="su-row2">
            <label className="su-field">
              <span>Assistant’s name</span>
              <input value={form.assistant} maxLength={24} placeholder="JARVIS" onChange={(e) => set({ assistant: e.target.value })} />
              <small>The wake phrase stays “Hey Jarvis”.</small>
            </label>
          </div>

          <div className="su-field">
            <span>Voice — click one to hear it</span>
            <div className="su-voices" role="listbox" aria-label="Voices">
              {voices.length === 0 && <small className="su-novoice">Loading the voices on this PC…</small>}
              {voices.map((v) => {
                const chosen = (voice || current) === v.name
                return (
                  <button
                    key={v.name}
                    type="button"
                    role="option"
                    aria-selected={chosen}
                    title={v.name}
                    className={`su-voice ${chosen ? 'su-on' : ''}`}
                    onClick={() => {
                      setVoice(v.name)
                      previewVoice(v.name, sample, rate)
                    }}
                  >
                    <span className="su-play" aria-hidden="true">▶</span>
                    <span className="su-vname">{v.name.replace(/^(Microsoft|Google)\s+/, '')}</span>
                    <small>{v.lang}</small>
                  </button>
                )
              })}
            </div>
            <small>Each plays: “{sample}”</small>
          </div>

          <div className="su-field">
            <span>Speech speed — {rate.toFixed(2)}×</span>
            <div className="su-rate">
              <small>Slower</small>
              <input
                type="range"
                min={0.6}
                max={1.8}
                step={0.05}
                value={rate}
                aria-label="Speech speed"
                onChange={(e) => setRate(Number(e.target.value))}
                // Let go (mouse, touch or keys) and hear the new speed.
                onPointerUp={() => previewVoice(voice || current, sample, rate)}
                onKeyUp={() => previewVoice(voice || current, sample, rate)}
              />
              <small>Faster</small>
              <button type="button" className="su-ghost su-reset" onClick={() => setRate(1)}>
                Normal
              </button>
            </div>
          </div>

          <div className="su-field">
            <span>Centre orb</span>
            <div className="su-orbs" role="radiogroup" aria-label="Centre orb">
              {ORBS.map((o) => {
                const on = (form.orb || 'reactor') === o.id
                return (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={`su-orb ${on ? 'su-on' : ''}`}
                    onClick={() => set({ orb: o.id })}
                  >
                    <Orb id={o.id} phase="dormant" level={0} className="orb-preview" />
                    <b>{o.label}</b>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="su-field">
            <span>Colour</span>
            <div className="su-themes">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`su-theme ${form.theme === t.id ? 'su-on' : ''}`}
                  style={{ ['--sw' as string]: t.swatch }}
                  aria-pressed={form.theme === t.id}
                  onClick={() => {
                    set({ theme: t.id })
                    applyTheme(t.id)
                  }}
                >
                  <i />
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="su-field">
            <span>AI accounts</span>
            <small>
              Claude works with your Claude login. Sign in to these as well and JARVIS can think with Gemini, Groq or
              OpenRouter (free) — pick one beside the text box, or leave it on Auto to switch when a limit is reached — and
              draw story characters with ChatGPT. A window opens to sign in; JARVIS sets up the rest. Nothing to copy or paste.
            </small>
            <ul className="su-accounts">
              {ACCOUNTS.map((a) => {
                const job = accounts?.jobs?.[a.id]
                const busy = job && (job.state === 'working' || job.state === 'waiting')
                const connected = accounts?.[a.id]?.connected
                return (
                  <li key={a.id} className={connected ? 'su-acc-on' : ''}>
                    <span className="su-acc-name">
                      <b>{a.label}</b>
                      <small>{busy || job?.state === 'failed' ? job.note : a.what}</small>
                    </span>
                    {busy ? (
                      <span className="su-acc-wait">
                        <i />
                        Signing in…
                      </span>
                    ) : leaving === a.id ? (
                      <span className="su-acc-wait">
                        <i />
                        {a.id === 'chatgpt' ? 'Signing out…' : 'Disconnecting…'}
                      </span>
                    ) : connected ? (
                      <span className="su-acc-done">
                        <span className="su-acc-ok">✓ Connected</span>
                        {a.key && (
                          <button type="button" className="su-acc-off" onClick={() => void disconnect(a.id)}>
                            Disconnect
                          </button>
                        )}
                      </span>
                    ) : connected === null && a.id === 'chatgpt' ? (
                      <span className="su-acc-wait">
                        <i />
                        Checking…
                      </span>
                    ) : (
                      <button type="button" className="su-google" disabled={!!accounts?.running} onClick={() => void signIn(a.id)}>
                        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                          <path fill="#4285F4" d="M22.5 12.3c0-.8-.1-1.5-.2-2.3H12v4.3h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2-1.9 3.2-4.7 3.2-8z" />
                          <path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1V17A11 11 0 0 0 12 23z" />
                          <path fill="#FBBC05" d="M5.8 14.2a6.6 6.6 0 0 1 0-4.4V7H2.1a11 11 0 0 0 0 10l3.7-2.8z" />
                          <path fill="#EA4335" d="M12 5.4c1.6 0 3 .6 4.2 1.6l3.1-3.1A11 11 0 0 0 2.1 7l3.7 2.8C6.7 7.3 9.1 5.4 12 5.4z" />
                        </svg>
                        Sign in
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>

          <div className="su-field">
            <span>Features</span>
            <div className="su-feats">
              {FEATURES.map((f) => (
                <label key={f.id} className={`su-feat ${form.features[f.id] !== false ? 'su-on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={form.features[f.id] !== false}
                    onChange={(e) => set({ features: { ...form.features, [f.id]: e.target.checked } })}
                  />
                  <b>{f.label}</b>
                  <small>{f.note}</small>
                </label>
              ))}
              {/* Off by default: their many tools are sent with every request. */}
              <label className={`su-feat ${form.connectors ? 'su-on' : ''}`}>
                <input type="checkbox" checked={form.connectors === true} onChange={(e) => set({ connectors: e.target.checked })} />
                <b>Gmail, Calendar & Drive</b>
                <small>Through your Claude account — uses more of your Claude usage</small>
              </label>
            </div>
          </div>

          {error && <p className="su-error" role="alert">{error}</p>}
        </div>

        <footer className="su-foot">
          <span className="su-credit">J.A.R.V.I.S. · created by <b>{profile?.creator ?? 'Sujith M'}</b></span>
          <span className="su-actions">
            {saving && <span className="su-saving">{saving}</span>}
            {firstRun ? (
              <button type="button" className="su-ghost" disabled={Boolean(saving)} onClick={() => void save(true)}>
                Skip for now
              </button>
            ) : (
              <button
                type="button"
                className="su-ghost"
                onClick={() => {
                  speechSynthesis.cancel()
                  applyTheme(profile?.theme)
                  setOpen(false)
                }}
              >
                Cancel
              </button>
            )}
            <button type="button" className="su-save" disabled={Boolean(saving)} onClick={() => void save()}>
              {firstRun ? 'Start' : 'Save'}
            </button>
          </span>
        </footer>
      </div>
    </div>
  )
}
