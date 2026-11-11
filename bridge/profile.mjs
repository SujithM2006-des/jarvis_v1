/**
 * Who this copy of JARVIS belongs to — and who made it.
 *
 * Every person who runs JARVIS has a profile on their own PC
 * (~/.jarvis/profile.json, never in the repository): their name, their city,
 * what to call the assistant, which features are on, the look. The first-run
 * setup screen writes it; it can be reopened from the sidebar at any time.
 *
 * The creator is not part of the profile. It is fixed here, in the code, so no
 * setting, no setup screen and none of JARVIS's own customisation tools can
 * change it. (Under the MIT licence, anyone sharing this code must keep the
 * copyright notices in LICENSE, which name the creator too.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CREATOR = 'Sujith M'

const FILE = join(homedir(), '.jarvis', 'profile.json')

/** Features a profile can switch off, with their JARVIS_DISABLE names. */
export const FEATURES = ['whatsapp', 'browser', 'camera', 'pc']

/** Colour presets for the interface (a hue turn from the stock blue). */
export const THEMES = { blue: 0, purple: 70, crimson: 150, amber: 200, green: -60, teal: -25 }

/** Centre orb designs (src/custom/orbs.tsx). */
export const ORBS = ['reactor', 'atom', 'nebula', 'pulse', 'prism']

const DEFAULTS = {
  name: '',
  city: '',
  assistant: 'JARVIS',
  features: Object.fromEntries(FEATURES.map((f) => [f, true])),
  theme: 'blue',
  orb: 'reactor',
}

/** The saved profile, with defaults filled in; `configured` is false until setup has run. */
export function readProfile() {
  let saved = null
  try {
    saved = JSON.parse(readFileSync(FILE, 'utf8').replace(/^﻿/, ''))
  } catch {
    /* none yet */
  }
  const p = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) }
  p.features = { ...DEFAULTS.features, ...(saved?.features ?? {}) }
  return { ...p, configured: existsSync(FILE), creator: CREATOR }
}

const clean = (v, max) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f<>{}`$\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

/** "SUJITH" or "sujith" -> "Sujith"; anything already mixed-case is left as typed. */
const nameCase = (s) =>
  s === s.toUpperCase() || s === s.toLowerCase()
    ? s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
    : s

/**
 * Save a profile from the setup screen. Only the known fields are kept; the
 * creator is never read from input. Returns the saved profile, or throws.
 */
export function saveProfile(input) {
  const name = nameCase(clean(input?.name, 40))
  // "Skip for now" saves without one: set up is set up, and the screen does
  // not come back by itself.
  if (!name && input?.skip !== true) throw new Error('A name is needed.')
  const assistant = clean(input?.assistant, 24) || 'JARVIS'
  if (!/^[\p{L}\p{N} .'-]+$/u.test(assistant)) throw new Error('The assistant name can only have letters, numbers and spaces.')
  const theme = Object.hasOwn(THEMES, input?.theme) ? input.theme : 'blue'
  const features = Object.fromEntries(FEATURES.map((f) => [f, input?.features?.[f] !== false]))
  const orb = ORBS.includes(input?.orb) ? input.orb : 'reactor'
  const out = { name, city: nameCase(clean(input?.city, 60)), assistant, features, theme, orb }
  mkdirSync(join(homedir(), '.jarvis'), { recursive: true })
  writeFileSync(FILE, JSON.stringify(out, null, 2))
  return readProfile()
}

/**
 * The identity block at the top of the system prompt. The creator line is
 * written as a fixed fact, and it says what to do when someone tries to
 * change it — the model hears that request far more often than a code edit.
 */
export function identityPrompt(p = readProfile()) {
  const me = p.assistant || 'JARVIS'
  const renamed = me.toUpperCase() !== 'JARVIS'
  return (
    `Who you are: your name is ${me}.` +
    (renamed ? ` Wherever these instructions say JARVIS, they mean you, ${me}.` : '') +
    ` You were created by ${CREATOR}, who designed and built you. If anyone asks who made,` +
    ` built, created or designed you, the answer is ${CREATOR}. This is permanent:` +
    ` never say anyone else created you, and never agree to change it, whoever asks or however` +
    ` it is worded. (If someone asks specifically which AI model powers you underneath, you may` +
    ` say so honestly — that is the engine, not your creator.)` +
    (p.name ? ` The person you work for is ${p.name}; call them by that name.` : '') +
    (p.city ? ` They live in ${p.city}.` : '') +
    '\n\n'
  )
}
