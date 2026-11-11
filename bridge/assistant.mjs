import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ps } from './pc.mjs'
import { forgetHistory, searchHistory } from './journal.mjs'
import { readProfile } from './profile.mjs'

/**
 * JARVIS as a personal assistant: long-term memory, reminders and timers,
 * scheduled WhatsApp messages, Windows notifications and the weather.
 *
 *   ~/.jarvis/memory.md       one fact per line, read into every session
 *   ~/.jarvis/reminders.json  [{ id, at, text, kind, repeat, contact, message }]
 *
 * The scheduler runs in the bridge process for as long as Jarvis is running.
 * Anything that fell due while it was off is handled when it next starts.
 */

const DIR = join(homedir(), '.jarvis')
const MEMORY = join(DIR, 'memory.md')
const REMINDERS = join(DIR, 'reminders.json')
mkdirSync(DIR, { recursive: true })

const ok = (text) => {
  console.log(`[jarvis] assistant ok: ${String(text).replace(/\s+/g, ' ').slice(0, 200)}`)
  return { content: [{ type: 'text', text }] }
}
const fail = (text) => {
  console.log(`[jarvis] assistant FAILED: ${String(text).replace(/\s+/g, ' ').slice(0, 200)}`)
  return { isError: true, content: [{ type: 'text', text: String(text) }] }
}

/** Writes go to a temp file first, so a crash mid-write never loses the lot. */
function writeSafe(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file + '.tmp', text)
  renameSync(file + '.tmp', file)
}

const spokenTime = (d) =>
  d.toLocaleString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
  })

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function memoryLines() {
  try {
    return readFileSync(MEMORY, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('- '))
  } catch {
    return []
  }
}

/** The memory, as a system prompt section. Empty when there is none. */
export function memoryPrompt() {
  const lines = memoryLines()
  if (!lines.length) return ''
  return (
    '\n\nWHAT YOU KNOW ABOUT THE USER — their own words, saved with `remember`. Use it ' +
    'silently: never recite it, never mention that you remembered.\n' +
    lines.join('\n') +
    '\n'
  )
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

function loadReminders() {
  try {
    const v = JSON.parse(readFileSync(REMINDERS, 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
const saveReminders = (list) => writeSafe(REMINDERS, JSON.stringify(list, null, 2))

/** "2026-11-10T18:00" (local) or minutes from now -> Date, or an error string. */
function parseWhen(at, inMinutes) {
  if (inMinutes != null && Number.isFinite(Number(inMinutes))) {
    return new Date(Date.now() + Number(inMinutes) * 60_000)
  }
  if (!at) return 'Give either at (local date and time) or in_minutes.'
  const s = String(at).trim().replace(' ', 'T')
  // Treat a bare local timestamp as local time, which is what new Date does
  // for YYYY-MM-DDTHH:MM without a zone.
  const d = new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s) ? s : at)
  if (Number.isNaN(d.getTime())) return `Could not read the time "${at}". Use YYYY-MM-DDTHH:MM in local time.`
  return d
}

function nextRepeat(at, repeat) {
  const d = new Date(at)
  const step = repeat === 'weekly' ? 7 : repeat === 'daily' ? 1 : 0
  if (!step) return null
  const now = Date.now()
  while (d.getTime() <= now) d.setDate(d.getDate() + step)
  return d
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])

/** A Windows toast notification that stays until dismissed. */
export async function toast(title, body) {
  const doc =
    `<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>${xml(title)}</text>` +
    `<text>${xml(body)}</text></binding></visual><actions><action content="Dismiss" arguments="dismiss" ` +
    `activationType="system"/></actions><audio src="ms-winsoundevent:Notification.Reminder"/></toast>`
  try {
    await ps(
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; ' +
        '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null; ' +
        '$x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml($env:JARVIS_X); ' +
        "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'; " +
        '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
      { X: doc },
    )
  } catch (err) {
    console.warn(`[jarvis] notification failed: ${err.message}`)
  }
}

let started = false

/**
 * The scheduler. `announce` speaks on every connected Jarvis window; `whatsapp`
 * sends a scheduled message and resolves with a tool-style result.
 */
export function startScheduler({ announce, whatsapp }) {
  if (started) return
  started = true
  let busy = false

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const now = Date.now()
      const list = loadReminders()
      const due = list.filter((r) => new Date(r.at).getTime() <= now)
      if (!due.length) return
      const keep = list.filter((r) => !due.includes(r))

      for (const r of due) {
        const late = now - new Date(r.at).getTime()
        const lateNote = late > 5 * 60_000 ? ` (this was due at ${spokenTime(new Date(r.at))})` : ''

        if (r.kind === 'whatsapp') {
          if (late > 2 * 60 * 60_000) {
            // Hours late: a birthday wish at three in the afternoon is worse than none.
            const msg = `A scheduled WhatsApp message to ${r.contact} was not sent, because Jarvis was off at ${spokenTime(new Date(r.at))}.`
            await toast('Jarvis: message not sent', msg)
            announce(`Sir, ${msg}`)
          } else {
            const res = await whatsapp(r.contact, r.message)
            const text = res?.content?.[0]?.text ?? ''
            if (res?.isError) {
              await toast('Jarvis: WhatsApp failed', `To ${r.contact}: ${text}`)
              announce(`Sir, the scheduled message to ${r.contact} could not be sent.`)
            } else {
              await toast('Jarvis: WhatsApp sent', `To ${r.contact}: ${r.message}`)
              announce(`The scheduled message to ${r.contact} has been sent, sir.`)
            }
          }
        } else {
          await toast('Jarvis reminder', r.text + lateNote)
          announce(`Sir, ${r.kind === 'timer' ? 'your timer is done' : 'a reminder'}: ${r.text}.${lateNote}`)
        }

        const next = nextRepeat(r.at, r.repeat)
        if (next) keep.push({ ...r, at: next.toISOString() })
        // The calendar keeps it on its day.
        archiveEvent(r)
      }
      saveReminders(keep)
    } catch (err) {
      console.error('[jarvis] scheduler error:', err)
    } finally {
      busy = false
    }
  }

  // A little after start, so a reminder that fell due while Jarvis was off is
  // announced once a window has had a chance to connect.
  setTimeout(tick, 20_000)
  setInterval(tick, 15_000)
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo: free, no key)
// ---------------------------------------------------------------------------

const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 95: 'thunderstorms',
  96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
}

// ---------------------------------------------------------------------------
// The calendar: pending reminders plus the ones already past
// ---------------------------------------------------------------------------

const PAST = join(DIR, 'past-events.json')

function loadPast() {
  try {
    const v = JSON.parse(readFileSync(PAST, 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** Keep a fired one-off reminder, so the calendar still shows it on its day. */
export function archiveEvent(r) {
  if (!r || r.kind === 'timer') return
  const past = loadPast()
  past.push({ id: r.id, at: r.at, text: r.kind === 'whatsapp' ? `WhatsApp ${r.contact}: ${r.message ?? ''}` : r.text, kind: r.kind })
  writeSafe(PAST, JSON.stringify(past.slice(-500), null, 2))
}

/** Every event the calendar can show: pending (with repeats) and past. */
export function scheduleList() {
  const pending = loadReminders()
    .filter((r) => r.kind !== 'timer')
    .map((r) => ({
      id: r.id,
      at: r.at,
      text: r.kind === 'whatsapp' ? `WhatsApp ${r.contact}: ${r.message ?? ''}` : r.text,
      kind: r.kind,
      repeat: r.repeat ?? null,
      done: false,
    }))
  const past = loadPast().map((r) => ({ ...r, repeat: null, done: true }))
  return [...past, ...pending].sort((a, b) => new Date(a.at) - new Date(b.at))
}

/** Add an event from the calendar (a reminder at that time). */
export function addSchedule({ at, text }) {
  const when = new Date(String(at ?? ''))
  const what = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (Number.isNaN(when.getTime())) throw new Error('That date and time could not be read.')
  if (!what) throw new Error('Say what the event is.')
  const r = { id: Math.random().toString(36).slice(2, 7), at: when.toISOString(), text: what, kind: 'reminder' }
  // Already past (an entry for earlier today, say): kept as a past event.
  if (when.getTime() < Date.now()) archiveEvent(r)
  else saveReminders([...loadReminders(), r])
  return r
}

/** Remove an event, pending or past. */
export function removeSchedule(id) {
  const key = String(id ?? '')
  const list = loadReminders()
  const keep = list.filter((r) => r.id !== key)
  if (keep.length !== list.length) saveReminders(keep)
  const past = loadPast()
  const keepPast = past.filter((r) => r.id !== key)
  if (keepPast.length !== past.length) writeSafe(PAST, JSON.stringify(keepPast, null, 2))
  return keep.length !== list.length || keepPast.length !== past.length
}

/** Upcoming scheduled items, soonest first — for the HUD. */
export function upcoming(n = 4) {
  return loadReminders()
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .slice(0, n)
    .map((r) => ({
      at: r.at,
      text: r.kind === 'whatsapp' ? `WhatsApp ${r.contact}` : r.text,
      kind: r.kind,
      repeat: r.repeat ?? null,
    }))
}

/**
 * The user's first name, from memory: "my name is …" / "the user's name is …",
 * else the name their own WhatsApp chat is saved under, else JARVIS_USER_NAME.
 * Null when nothing says — the interface then says "sir".
 */
export function userName() {
  // The name given in setup wins; memory is for copies set up before it.
  const set = readProfile().name
  if (set) return set.split(/\s+/)[0]
  const lines = memoryLines()
  for (const l of lines) {
    const m = l.match(/\b(?:my|user'?s|the user'?s)\s+name\s+is\s+"?([A-Z][\w'-]+)/i)
    if (m) return m[1]
  }
  for (const l of lines) {
    if (!/own|yourself/i.test(l)) continue
    const m = l.match(/saved as\s+"([^"]+)"/i)
    if (m) return m[1].split(/\s+/)[0]
  }
  return process.env.JARVIS_USER_NAME?.trim() || null
}

/** The remembered city, if a memory line mentions one ("…city is Salem"). */
function rememberedCity() {
  for (const l of memoryLines()) {
    const m = l.match(/\b(?:city|live in|living in|based in|from)\b(?: is)?\s+([A-Z][\w .'-]{1,40})/i)
    if (m) return m[1].replace(/[.,;].*$/, '').trim()
  }
  // Then the city given in setup.
  return readProfile().city || null
}

let weatherCache = { at: 0, data: null }

/** Structured weather for the HUD, cached for fifteen minutes. */
export async function weatherData() {
  if (weatherCache.data && Date.now() - weatherCache.at < 15 * 60_000) return weatherCache.data
  const raw = await weatherRaw(null)
  const data = {
    city: raw.place.name,
    temp: Math.round(raw.w.current.temperature_2m),
    feels: Math.round(raw.w.current.apparent_temperature),
    humidity: raw.w.current.relative_humidity_2m,
    wind: Math.round(raw.w.current.wind_speed_10m),
    cond: WMO[raw.w.current.weather_code] ?? '',
    hi: Math.round(raw.w.daily.temperature_2m_max[0]),
    lo: Math.round(raw.w.daily.temperature_2m_min[0]),
    rain: raw.w.daily.precipitation_probability_max[0],
  }
  weatherCache = { at: Date.now(), data }
  return data
}

async function weather(city) {
  const { place, w } = await weatherRaw(city)
  const c = w.current
  const d = w.daily
  return (
    `${place.name}${place.admin1 ? ', ' + place.admin1 : ''}. Now: ${Math.round(c.temperature_2m)}°C ` +
    `(feels ${Math.round(c.apparent_temperature)}°C), ${WMO[c.weather_code] ?? 'unknown'}, humidity ` +
    `${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h. Today: ` +
    `${Math.round(d.temperature_2m_min[0])} to ${Math.round(d.temperature_2m_max[0])}°C, ` +
    `${WMO[d.weather_code[0]] ?? ''}, ${d.precipitation_probability_max[0]}% chance of rain. Tomorrow: ` +
    `${Math.round(d.temperature_2m_min[1])} to ${Math.round(d.temperature_2m_max[1])}°C, ` +
    `${WMO[d.weather_code[1]] ?? ''}, ${d.precipitation_probability_max[1]}% chance of rain.`
  )
}

// ---------------------------------------------------------------------------
// Where the user is
// ---------------------------------------------------------------------------

let locationCache = { at: 0, data: null }

/**
 * The PC's own location from Windows (Wi-Fi positioning, GPS if fitted) —
 * typically within a few hundred metres, where the internet provider's guess
 * can be a different city. Named by reverse geocoding. Refreshed at most every
 * 20 minutes. Null when Windows location is off or refused.
 */
export async function preciseLocation() {
  if (locationCache.data && Date.now() - locationCache.at < 20 * 60_000) return locationCache.data
  const json = await ps(
    'Add-Type -AssemblyName System.Device; ' +
      '$w = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High); ' +
      "$w.Start(); $t = 0; while ($w.Status -ne 'Ready' -and $w.Permission -ne 'Denied' -and $t -lt 100) { Start-Sleep -Milliseconds 100; $t++ }; " +
      '$c = $w.Position.Location; $w.Stop(); ' +
      "if ($c.IsUnknown) { 'null' } else { [pscustomobject]@{ lat = $c.Latitude; lon = $c.Longitude; acc = $c.HorizontalAccuracy } | ConvertTo-Json -Compress }",
    {},
    20_000,
  )
  const pos = JSON.parse(json || 'null')
  if (!pos || !Number.isFinite(pos.lat)) return null
  let name = ''
  let city = ''
  let region = ''
  let country = ''
  try {
    const g = await (await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${pos.lat}&longitude=${pos.lon}&localityLanguage=en`,
    )).json()
    city = g.city || g.locality || ''
    name = g.locality && g.locality !== city ? `${g.locality}, ${city}` : city
    region = g.principalSubdivision || ''
    country = g.countryName || ''
  } catch {
    /* coordinates are enough for the weather */
  }
  const data = {
    lat: +pos.lat.toFixed(4),
    lon: +pos.lon.toFixed(4),
    accuracyM: Math.round(pos.acc || 0),
    name: name || `${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}`,
    city,
    region,
    country,
  }
  locationCache = { at: Date.now(), data }
  return data
}

async function weatherRaw(city) {
  let place
  if (city) {
    const g = await (await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`,
    )).json()
    place = g.results?.[0]
    if (!place) throw new Error(`No place called ${city} was found.`)
  } else {
    // Where they actually are: Windows location (Wi-Fi/GPS), then a city
    // they told him to remember, then — last — the internet provider's
    // rough guess, which is often a city or more away.
    const here = await preciseLocation().catch(() => null)
    const remembered = here ? null : rememberedCity()
    if (here) {
      place = { name: here.name, latitude: here.lat, longitude: here.lon, admin1: here.region }
    } else if (remembered) {
      return weatherRaw(remembered)
    } else {
      const ip = await (await fetch('https://ipwho.is/')).json()
      if (!ip?.success) throw new Error('Could not work out where you are; give a city.')
      place = { name: ip.city, latitude: ip.latitude, longitude: ip.longitude, admin1: ip.region }
    }
  }
  const w = await (await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&forecast_days=2&timezone=auto',
  )).json()
  if (!w?.current) throw new Error('the weather service did not answer')
  return { place, w }
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export function assistantServer({ allowWrites }) {
  return createSdkMcpServer({
    name: 'jarvis_assistant',
    version: '1.0.0',
    instructions: "The user's personal assistant: memory, reminders, timers, scheduled messages, weather.",
    alwaysLoad: true,
    tools: [
      tool(
        'remember',
        'Save a fact about the user for every future conversation: names and who people are ' +
          '("Mum is saved as Mum ❤️ in WhatsApp"), their timetable, preferences, ' +
          'city, birthdays. Use when they say "remember…", and when they correct you about ' +
          'something you should not get wrong again. One fact per call, in plain words.',
        { fact: z.string() },
        async ({ fact }) => {
          const line = fact.replace(/\s+/g, ' ').trim()
          if (!line) return fail('Nothing to remember.')
          const lines = memoryLines()
          if (lines.some((l) => l.slice(2).toLowerCase() === line.toLowerCase())) return ok('Already remembered.')
          const header = existsSync(MEMORY) ? '' : '# What Jarvis knows about you\n\nOne fact per line. Edit freely.\n\n'
          writeSafe(MEMORY, (existsSync(MEMORY) ? readFileSync(MEMORY, 'utf8').replace(/\s*$/, '\n') : header) + `- ${line}\n`)
          return ok('Remembered.')
        },
      ),
      tool(
        'forget',
        'Remove remembered facts containing the given words (when they say "forget that…" or a ' +
          'fact has changed — then remember the new one).',
        { matching: z.string() },
        async ({ matching }) => {
          const m = matching.toLowerCase().trim()
          if (!m) return fail('Say what to forget.')
          // The conversation history too: "forget what I said about X" should
          // not leave X sitting in the journal to come back next session.
          const fromHistory = forgetHistory(m)
          const historyNote = fromHistory ? ` Also removed ${fromHistory} past exchange(s) mentioning it.` : ''
          let text = ''
          try {
            text = readFileSync(MEMORY, 'utf8')
          } catch {
            return ok(`There are no remembered facts.${historyNote}`)
          }
          const removed = []
          const kept = text.split(/\r?\n/).filter((l) => {
            const hit = l.trim().startsWith('- ') && l.toLowerCase().includes(m)
            if (hit) removed.push(l.trim().slice(2))
            return !hit
          })
          if (!removed.length) return ok(`No remembered fact mentions "${matching}".${historyNote}`)
          writeSafe(MEMORY, kept.join('\n'))
          return ok(`Forgot: ${removed.join(' | ')}.${historyNote}`)
        },
      ),
      tool(
        'my_location',
        'Where the user is right now, from their PC\'s location (Wi-Fi positioning — usually within ' +
          'a few hundred metres): area, city, region, country and coordinates. Use for "where am I", ' +
          'and before anything "near me" (restaurants, hospitals, petrol, directions, local news).',
        {},
        async () => {
          try {
            const here = await preciseLocation()
            if (!here) {
              return fail(
                'Windows location is off or not allowed for desktop apps (Settings → Privacy & security → ' +
                  'Location). Ask which city they are in instead.',
              )
            }
            return ok(
              `${here.name}${here.region ? `, ${here.region}` : ''}${here.country ? `, ${here.country}` : ''} ` +
                `(${here.lat}, ${here.lon}; accurate to about ${here.accuracyM} m).`,
            )
          } catch (err) {
            return fail(`Could not get the location: ${err.message}`)
          }
        },
      ),
      tool(
        'search_history',
        'Search everything the user and you have said and done in past conversations, kept ' +
          'across restarts. Use for "what did I ask you yesterday", "what was that file you ' +
          'saved", "what did we talk about last week", or whenever they refer to something ' +
          'earlier that is not in your recent conversations. Keywords, not a sentence. ' +
          'Leave query empty to get the latest exchanges.',
        {
          query: z.string().describe('Keywords, e.g. "eclipse palindrome", "pdf abstract".'),
          days: z.number().optional().describe('Only the last N days.'),
        },
        async ({ query, days }) => {
          const hits = searchHistory(query, { days })
          return ok(hits.length ? hits.join('\n') : `Nothing in past conversations matches "${query}".`)
        },
      ),
      tool(
        'recall',
        'List everything remembered about the user (only when they ask what you know).',
        {},
        async () => {
          const lines = memoryLines()
          return ok(lines.length ? lines.join('\n') : 'Nothing is remembered yet.')
        },
      ),
      tool(
        'set_reminder',
        'Set a reminder, a timer, or a scheduled WhatsApp message. When it is due Jarvis says it ' +
          'aloud and shows a Windows notification. Time: either in_minutes (timers, "in 20 ' +
          'minutes") or at, a LOCAL date and time "YYYY-MM-DDTHH:MM" worked out from the ' +
          'current time given with the user\'s message ("at 6" today if still ahead, else ' +
          'tomorrow; "12 am" means the coming midnight). repeat: daily or weekly for routines. ' +
          'For a scheduled WhatsApp message give whatsapp_to (contact exactly as in WhatsApp) ' +
          'and whatsapp_message; it is sent automatically at that time.',
        {
          text: z.string().describe('What to remind them of, short: "call Mum", "submit the assignment".'),
          at: z.string().optional(),
          in_minutes: z.number().optional(),
          kind: z.enum(['reminder', 'timer']).optional(),
          repeat: z.enum(['none', 'daily', 'weekly']).optional(),
          whatsapp_to: z.string().optional(),
          whatsapp_message: z.string().optional(),
        },
        async ({ text, at, in_minutes, kind, repeat, whatsapp_to, whatsapp_message }) => {
          const when = parseWhen(at, in_minutes)
          if (typeof when === 'string') return fail(when)
          if (when.getTime() < Date.now() - 60_000) {
            return fail(`${spokenTime(when)} has already passed. Pick a time in the future.`)
          }
          const isWa = Boolean(whatsapp_to)
          if (isWa && !allowWrites) return fail('Scheduled messages need write access, which is off.')
          if (isWa && !whatsapp_message?.trim()) return fail('Give the message to send.')
          const r = {
            id: Math.random().toString(36).slice(2, 7),
            at: when.toISOString(),
            text,
            kind: isWa ? 'whatsapp' : kind ?? (in_minutes != null ? 'timer' : 'reminder'),
            repeat: repeat && repeat !== 'none' ? repeat : undefined,
            contact: isWa ? whatsapp_to : undefined,
            message: isWa ? whatsapp_message : undefined,
          }
          saveReminders([...loadReminders(), r])
          return ok(
            `${isWa ? `WhatsApp to ${whatsapp_to}` : r.kind === 'timer' ? 'Timer' : 'Reminder'} set for ` +
              `${spokenTime(when)}${r.repeat ? `, repeating ${r.repeat}` : ''} (id ${r.id}).`,
          )
        },
      ),
      tool(
        'list_reminders',
        'List upcoming reminders, timers and scheduled messages, soonest first.',
        {},
        async () => {
          const list = loadReminders().sort((a, b) => new Date(a.at) - new Date(b.at))
          if (!list.length) return ok('Nothing is scheduled.')
          return ok(
            list
              .map((r) =>
                `${r.id}: ${spokenTime(new Date(r.at))} — ${
                  r.kind === 'whatsapp' ? `WhatsApp to ${r.contact}: "${r.message}"` : `${r.kind}: ${r.text}`
                }${r.repeat ? ` (${r.repeat})` : ''}`,
              )
              .join('\n'),
          )
        },
      ),
      tool(
        'cancel_reminder',
        'Cancel scheduled items by id, or every one whose text, contact or message contains the ' +
          'given words. "all" cancels everything.',
        { match: z.string() },
        async ({ match }) => {
          const m = match.toLowerCase().trim()
          const list = loadReminders()
          const hit = (r) =>
            m === 'all' || r.id === m ||
            [r.text, r.contact, r.message].some((v) => v && v.toLowerCase().includes(m))
          const gone = list.filter(hit)
          if (!gone.length) return ok(`Nothing scheduled matches "${match}".`)
          saveReminders(list.filter((r) => !hit(r)))
          return ok(`Cancelled ${gone.length}: ${gone.map((r) => r.text || r.message).join('; ')}`)
        },
      ),
      tool(
        'weather',
        'Current weather and the forecast for today and tomorrow. Leave city out for where the ' +
          'user actually is right now (their PC\'s location); give a city only when they name one.',
        { city: z.string().optional() },
        async ({ city }) => {
          try {
            return ok(await weather(city || null))
          } catch (err) {
            return fail(`Weather is unavailable: ${err.message}`)
          }
        },
      ),
    ],
  })
}
