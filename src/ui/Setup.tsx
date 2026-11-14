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
  const [savedKeys, setSavedKeys] = useState<Record<string, string>>({})
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
      fetch(`${BRIDGE_HTTP_URL}/keys`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : {}))
        .then((k) => setSavedKeys(k ?? {}))
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
            <span>AI models — optional keys</span>
            <small>
              Claude works with your Claude login. Add a free key to also use Gemini, Groq or OpenRouter — pick one in
              the dropdown beside the text box, or leave it on Auto to switch when a limit is reached. Keys stay on this PC.
            </small>
            <div className="su-keys">
              {[
                { id: 'gemini', label: 'Gemini', where: 'aistudio.google.com/apikey' },
                { id: 'groq', label: 'Groq', where: 'console.groq.com/keys' },
                { id: 'openrouter', label: 'OpenRouter', where: 'openrouter.ai/keys' },
              ].map((p) => {
                const removing = keyInput[p.id] === null
                return (
                  <label key={p.id} className="su-key">
                    <b>{p.label}</b>
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={removing ? '' : (keyInput[p.id] ?? '')}
                      placeholder={removing ? 'will be removed' : savedKeys[p.id] ? `saved ${savedKeys[p.id]}` : `key from ${p.where}`}
                      onChange={(e) => setKeyInput({ ...keyInput, [p.id]: e.target.value })}
                    />
                    {savedKeys[p.id] && !removing && (
                      <button type="button" className="su-ghost su-key-x" onClick={() => setKeyInput({ ...keyInput, [p.id]: null })}>
                        Remove
                      </button>
                    )}
                  </label>
                )
              })}
            </div>
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
