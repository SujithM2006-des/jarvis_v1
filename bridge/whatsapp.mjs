import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { homedir, tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { protectedProblem, resolveUserPath } from './pc.mjs'

/**
 * WhatsApp Web, driven through the user's installed Chrome.
 *
 * A dedicated Chrome profile (~/.jarvis/whatsapp-profile) keeps the WhatsApp
 * login between runs: scan the QR code once and it stays linked, exactly like
 * a normal browser. Separate from the user's everyday Chrome profile, so the
 * two never fight over a lock.
 *
 * Driven with playwright-core rather than the Claude extension because sending
 * a file needs a real file chooser, which only a debugging-protocol driver can
 * fill.
 *
 * WhatsApp changes its markup now and then, so every element is looked up
 * through several fallbacks, and a failure saves a screenshot and says where.
 */

const PROFILE = join(homedir(), '.jarvis', 'whatsapp-profile')
const WA_URL = 'https://web.whatsapp.com/'

let ctx = null
let page = null

/** One operation at a time: two sends racing in one window would interleave. */
const CLOSED = /has been closed|Target closed/i
let queue = Promise.resolve()
const serial = (fn) => {
  // Chrome can swap its first tab out from under us on startup, and the user
  // can close the window; either way, forget the page and try once more.
  const once = async () => {
    let result = await fn()
    if (result?.isError && CLOSED.test(result.content?.[0]?.text ?? '')) {
      page = null
      result = await fn()
    }
    // Into the bridge log, so "it didn't send" can be traced afterwards.
    console.log(
      `[jarvis] whatsapp ${result?.isError ? 'FAILED' : 'ok'}: ` +
        String(result?.content?.[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 300),
    )
    return result
  }
  const run = queue.then(once, once)
  queue = run.catch(() => {})
  return run
}

async function getPage() {
  if (page && !page.isClosed()) return page
  // The window is still open but the tab we held went away: adopt another.
  if (ctx) {
    page = ctx.pages().find((pg) => !pg.isClosed()) ?? (await ctx.newPage().catch(() => null))
    if (page) {
      if (!page.url().startsWith(WA_URL)) await page.goto(WA_URL, { waitUntil: 'domcontentloaded' })
      return page
    }
    ctx = null
  }
  const { chromium } = await import('playwright-core')
  mkdirSync(PROFILE, { recursive: true })
  ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  })
  ctx.on('close', () => {
    ctx = null
    page = null
  })
  page = ctx.pages()[0] ?? (await ctx.newPage())
  if (!page.url().startsWith(WA_URL)) await page.goto(WA_URL, { waitUntil: 'domcontentloaded' })
  return page
}

/** 'ready' (logged in), 'qr' (needs linking) or 'loading'. */
async function loginState(p, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await p.locator('#pane-side').count()) return 'ready'
    const qr =
      (await p.locator('canvas').count()) > 0 ||
      (await p.getByText(/scan (the|this) qr|log in with phone number|link with phone/i).count()) > 0
    if (qr) {
      // The QR page can flash up before a saved session restores; give it a beat.
      await p.waitForTimeout(2500)
      if (!(await p.locator('#pane-side').count())) return 'qr'
    }
    await p.waitForTimeout(400)
  }
  return 'loading'
}

async function ensureReady() {
  const p = await getPage()
  const state = await loginState(p)
  if (state === 'qr') {
    await p.bringToFront()
    throw new Error(
      'WhatsApp is not linked yet. The WhatsApp window is open with a QR code: ask the ' +
        'user to scan it with their phone (WhatsApp > Settings > Linked devices > Link a ' +
        'device), then try again.',
    )
  }
  if (state !== 'ready') throw new Error('WhatsApp Web did not finish loading.')
  return p
}

/** First of several candidate locators that is visible, waiting up to timeoutMs. */
async function firstVisible(p, makers, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    for (const make of makers) {
      const loc = make().first()
      if (await loc.isVisible().catch(() => false)) return loc
    }
    await p.waitForTimeout(250)
  }
  return null
}

async function failWith(p, label, message) {
  let shot = null
  try {
    shot = join(tmpdir(), `jarvis-whatsapp-${label}-${Date.now()}.png`)
    await p.screenshot({ path: shot })
  } catch {
    shot = null
  }
  throw new Error(message + (shot ? ` A screenshot of the WhatsApp window is at ${shot}.` : ''))
}

const searchBox = (p) =>
  firstVisible(p, [
    () => p.locator('#side').getByRole('textbox'),
    () => p.getByRole('textbox', { name: /search/i }),
    () => p.locator('#side div[contenteditable="true"]'),
    () => p.locator('div[contenteditable="true"][data-tab="3"]'),
  ])

const messageBox = (p) =>
  firstVisible(p, [
    () => p.locator('#main footer div[contenteditable="true"]'),
    () => p.getByRole('textbox', { name: /type a message/i }),
  ], 15_000)

const PHONE = /^\+?[\d\s()-]{7,20}$/

/** Chat names shown in the left pane right now. */
async function visibleChatNames(p) {
  // Each chat row holds the chat name first and the last-message preview after
  // it, and both carry a title. Only the first title per row is a name.
  const titles = await p.locator('#pane-side span[title]').evaluateAll((els) => {
    const rows = new Set()
    const out = []
    for (const e of els) {
      const row = e.closest('[role="row"],[role="listitem"]')
      if (row) {
        if (rows.has(row)) continue
        rows.add(row)
      }
      out.push(e.getAttribute('title') || '')
    }
    return out
  })
  // WhatsApp wraps some text in invisible direction marks.
  const clean = titles.map((t) => t.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim())
  return [...new Set(clean.filter((t) => t && t.length <= 80))]
}

async function search(p, query) {
  const box = await searchBox(p)
  if (!box) await failWith(p, 'search', 'Could not find the WhatsApp search box.')
  await box.click()
  await p.keyboard.press('Control+A')
  await p.keyboard.press('Backspace')
  await p.keyboard.insertText(query)
  await p.waitForTimeout(1800)
}

async function clearSearch(p) {
  const box = await searchBox(p)
  if (!box) return
  await box.click().catch(() => {})
  await p.keyboard.press('Control+A').catch(() => {})
  await p.keyboard.press('Backspace').catch(() => {})
}

/**
 * A name as words only: emoji, skin tones, joiners and direction marks gone,
 * spaces collapsed, lower case. "Mum ❤️" and "Mum" compare equal, which is
 * how anyone says a name out loud. The same rules run in the page (below).
 */
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}‍︎️⃣‎‏‪-‮⁦-⁩]/gu
const plain = (s) => String(s).replace(EMOJI_RE, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
const lower = plain

/**
 * Open the chat for `contact`, refusing to guess.
 * An exact name match wins; otherwise exactly one partial match is accepted;
 * otherwise the candidates are returned for the user to choose between.
 */
async function openChat(p, contact) {
  const wanted = String(contact).trim()
  if (!wanted) throw new Error('No contact given.')

  if (PHONE.test(wanted)) {
    const digits = wanted.replace(/[^\d]/g, '')
    await p.goto(`${WA_URL}send?phone=${digits}`, { waitUntil: 'domcontentloaded' })
    await loginState(p)
    const box = await messageBox(p)
    if (!box) {
      if (await p.getByText(/invalid|not on whatsapp/i).count()) {
        throw new Error(`The number ${wanted} is not on WhatsApp.`)
      }
      await failWith(p, 'phone', `Could not open a chat with ${wanted}.`)
    }
    return wanted
  }

  await search(p, wanted)
  const names = await visibleChatNames(p)
  const w = lower(wanted)
  const exact = names.filter((n) => lower(n) === w)
  const partial = names.filter(
    (n) => lower(n).includes(w) || w.split(/\s+/).every((x) => lower(n).includes(x)),
  )
  const pick =
    exact.length === 1 ? exact[0] : exact.length === 0 && partial.length === 1 ? partial[0] : null

  if (!pick) {
    await clearSearch(p)
    if (!partial.length && !exact.length) {
      throw new Error(
        `No WhatsApp chat or contact matches "${wanted}".` +
          (names.length ? ` Search showed: ${names.slice(0, 8).join('; ')}.` : '') +
          ' Nothing was sent.',
      )
    }
    const list = (exact.length > 1 ? exact : partial).slice(0, 8)
    throw new Error(
      `More than one WhatsApp contact could be "${wanted}": ${list.join('; ')}. ` +
        'Ask the user which one, then use the exact name. Nothing was sent.',
    )
  }

  // Click by the title attribute, not the visible text: WhatsApp draws emoji
  // as images, so "Mum ❤️" reads as "Mum " on screen and a text match fails.
  // Only the first title in each row counts — that is the name, not a preview.
  const titles = p.locator('#pane-side span[title]')
  const index = await titles.evaluateAll(
    (els, [want, src]) => {
      const re = new RegExp(src, 'gu')
      const norm = (s) => String(s).replace(re, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
      const rows = new Set()
      for (let i = 0; i < els.length; i++) {
        const row = els[i].closest('[role="row"],[role="listitem"]')
        if (row) {
          if (rows.has(row)) continue
          rows.add(row)
        }
        if (norm(els[i].getAttribute('title') || '') === want) return i
      }
      return -1
    },
    [plain(pick), EMOJI_RE.source],
  )
  if (index < 0) await failWith(p, 'click', `Could not find ${pick} in the chat list. Nothing was sent.`)
  await titles.nth(index).click()

  // Make sure the right conversation is actually open before anything is typed.
  // The header is compared the same emoji-blind way, including image alt text.
  const want = plain(pick)
  const end = Date.now() + 6000
  let opened = false
  while (!opened && Date.now() < end) {
    const header = await p
      .locator('#main header')
      .evaluate((h) => {
        const bits = [h.innerText]
        h.querySelectorAll('[title]').forEach((e) => bits.push(e.getAttribute('title') || ''))
        h.querySelectorAll('img[alt]').forEach((e) => bits.push(e.getAttribute('alt') || ''))
        return bits.join(' \n ')
      })
      .catch(() => '')
    opened = want ? header.split('\n').some((line) => plain(line).includes(want)) : header.includes(pick)
    if (!opened) await p.waitForTimeout(250)
  }
  if (!opened) await failWith(p, 'open', `Could not confirm the chat with ${pick} opened. Nothing was sent.`)
  return pick
}

/** Type text; new lines become Shift+Enter so they do not send early. */
async function typeMessage(p, text) {
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await p.keyboard.insertText(lines[i])
    if (i < lines.length - 1) await p.keyboard.press('Shift+Enter')
  }
}

async function sendText(contact, message) {
  const p = await ensureReady()
  const name = await openChat(p, contact)
  const box = await messageBox(p)
  if (!box) await failWith(p, 'box', 'Could not find the message box. Nothing was sent.')
  await box.click()
  await typeMessage(p, message)
  await p.keyboard.press('Enter')
  await p.waitForTimeout(800)
  return name
}

const MEDIA_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.3gp', '.mov', '.avi', '.mkv'])

async function setViaInput(p, files, media) {
  const inputs = p.locator('input[type="file"]')
  const n = await inputs.count()
  if (!n) await failWith(p, 'input', 'Could not reach the file picker. Nothing was sent.')
  let target = inputs.first()
  for (let i = 0; i < n; i++) {
    const accept = (await inputs.nth(i).getAttribute('accept')) ?? ''
    if (media ? accept.includes('image') : accept === '*' || accept === '') {
      target = inputs.nth(i)
      break
    }
  }
  await target.setInputFiles(files)
}

async function sendFiles(contact, files, caption, asDocument) {
  const p = await ensureReady()
  const name = await openChat(p, contact)

  const attach = await firstVisible(p, [
    () => p.locator('#main footer').getByRole('button', { name: /attach/i }),
    () => p.locator('#main footer [title="Attach"]'),
    () => p.locator('#main footer span[data-icon="plus-rounded"]'),
    () => p.locator('#main footer span[data-icon="plus"]'),
    () => p.locator('#main footer span[data-icon="attach-menu-plus"]'),
    () => p.locator('#main footer span[data-icon="clip"]'),
  ])
  if (!attach) await failWith(p, 'attach', 'Could not find the attach button. Nothing was sent.')
  await attach.click()

  const media = !asDocument && files.every((f) => MEDIA_EXT.has(extname(f).toLowerCase()))
  const label = media ? /photos? (&|and) videos?/i : /^document$/i
  const item = await firstVisible(p, [
    () => p.getByRole('button', { name: label }),
    () => p.getByRole('menuitem', { name: label }),
    () => p.getByRole('listitem').filter({ hasText: label }),
    () => p.getByText(label),
  ], 5000)

  if (item) {
    try {
      const [chooser] = await Promise.all([
        p.waitForEvent('filechooser', { timeout: 6000 }),
        item.click(),
      ])
      await chooser.setFiles(files)
    } catch {
      await setViaInput(p, files, media)
    }
  } else {
    await setViaInput(p, files, media)
  }

  // The preview: optional caption, then the send button.
  const send = await firstVisible(p, [
    // Labelled "Send 1 selected" / "Send 3 selected" in the 2026 preview.
    () => p.getByRole('button', { name: /^send\b/i }),
    () => p.locator('[aria-label="Send"]'),
    () => p.locator('span[data-icon="send"]'),
    () => p.locator('span[data-icon="wds-ic-send-filled"]'),
  ], 20_000)
  if (!send) await failWith(p, 'preview', 'The file preview did not appear. Nothing was sent.')

  if (caption) {
    const cap = await firstVisible(p, [
      // The preview's caption box is exactly "Type a message"; the chat's own
      // box behind it is "Type a message to <name>", so the exact match matters.
      () => p.getByRole('textbox', { name: 'Type a message', exact: true }),
      () => p.getByRole('textbox', { name: /caption|add a message/i }),
      () => p.locator('div[contenteditable="true"][aria-placeholder*="caption" i]'),
    ], 3000)
    if (cap) {
      await cap.click()
      await typeMessage(p, caption)
    }
  }
  await send.click()
  // The preview closing is WhatsApp accepting the upload.
  await send.waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {})
  await p.waitForTimeout(800)
  return name
}

async function readChat(contact, count) {
  const p = await ensureReady()
  const name = await openChat(p, contact)
  await p.waitForTimeout(1000)
  const rows = await p.locator('#main [role="row"]').evaluateAll((els) =>
    els.map((e) => {
      const out = e.querySelector('.message-out')
      const meta = e.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') ?? ''
      const text = e.querySelector('.copyable-text span[dir]')?.innerText ?? e.innerText
      return `${out ? 'Me' : 'Them'} ${meta.trim()} ${String(text).replace(/\s+/g, ' ').trim()}`
    }),
  )
  return { name, lines: rows.filter(Boolean).slice(-count) }
}

/**
 * Chats with unread messages: name, how many, last message preview.
 * Uses WhatsApp's own "Unread" filter so the list is complete, then puts the
 * filter back to "All".
 */
async function unreadChats() {
  const p = await ensureReady()
  await clearSearch(p)
  const chip = await firstVisible(p, [
    () => p.getByRole('button', { name: /^unread/i }),
    () => p.getByRole('tab', { name: /^unread/i }),
    () => p.locator('#side').getByText(/^unread/i),
  ], 4000)
  if (chip) {
    await chip.click()
    await p.waitForTimeout(1500)
  }
  const rows = await p.locator('#pane-side [role="row"], #pane-side [role="listitem"]').evaluateAll((els) =>
    els.map((r) => {
      const titles = [...r.querySelectorAll('span[title]')].map((e) => e.getAttribute('title') || '')
      const badge = [...r.querySelectorAll('[aria-label]')]
        .map((e) => e.getAttribute('aria-label') || '')
        .find((a) => /unread message/i.test(a))
      return { name: titles[0] || '', preview: titles[1] || '', badge: badge || '' }
    }),
  )
  if (chip) {
    const all = await firstVisible(p, [
      () => p.getByRole('button', { name: /^all$/i }),
      () => p.getByRole('tab', { name: /^all$/i }),
      () => p.locator('#side').getByText(/^all$/i),
    ], 2000)
    await all?.click().catch(() => {})
  }
  const clean = (s) => s.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim()
  return rows
    .filter((r) => r.name && (chip || r.badge))
    .map((r) => {
      const n = r.badge.match(/(\d+)/)?.[1]
      return `${clean(r.name)}${n ? ` (${n} unread)` : ''}: ${clean(r.preview).replace(/\s+/g, ' ').slice(0, 120)}`
    })
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] })

/** For the HUD dock: bring the WhatsApp window up (launching it if needed). */
export function showWhatsApp() {
  return serial(async () => {
    try {
      const p = await getPage()
      await p.bringToFront()
      return ok('WhatsApp is open.')
    } catch (err) {
      return fail(err)
    }
  })
}

/** For the reminder scheduler: send a text, through the same queue as the tools. */
export function sendScheduled(contact, message) {
  return serial(async () => {
    try {
      const name = await sendText(contact, message)
      return ok(`Message sent to ${name}.`)
    } catch (err) {
      return fail(err)
    }
  })
}

/** Tools that send something to another person. */
export const WHATSAPP_WRITE_TOOLS = new Set(['send_message', 'send_file'])

const contactArg = z
  .string()
  .describe(
    'The contact or group name as the user said it (e.g. "Mom", "Rahul", ' +
      '"College friends"), or a phone number with country code (e.g. "+91 98765 43210").',
  )

export function whatsappServer({ allowWrites }) {
  const tools = [
    tool(
      'open',
      'Open the WhatsApp Web window and report whether it is linked. If it shows a QR ' +
        'code, the user must scan it once with their phone.',
      {},
      () =>
        serial(async () => {
          try {
            const p = await getPage()
            await p.bringToFront()
            const state = await loginState(p)
            return ok(
              state === 'ready'
                ? 'WhatsApp is open and linked.'
                : state === 'qr'
                  ? 'WhatsApp is showing a QR code. The user must scan it: on the phone, WhatsApp > Settings > Linked devices > Link a device.'
                  : 'WhatsApp is still loading.',
            )
          } catch (err) {
            return fail(err)
          }
        }),
    ),
    tool(
      'find_contact',
      'Search WhatsApp chats and contacts by name and list the matches. Use it when a ' +
        'name is ambiguous or you are unsure how the contact is saved.',
      { query: z.string() },
      ({ query }) =>
        serial(async () => {
          try {
            const p = await ensureReady()
            await search(p, query)
            const names = await visibleChatNames(p)
            await clearSearch(p)
            return ok(names.length ? `Matches: ${names.slice(0, 15).join('; ')}` : `No chats match "${query}".`)
          } catch (err) {
            return fail(err)
          }
        }),
    ),
    tool(
      'unread',
      'List the WhatsApp chats with unread messages: who, how many, and the last message. ' +
        'Use for "any new messages", "read my unread messages", and in the morning briefing. ' +
        'Follow up with read_chat for the chats that matter.',
      {},
      () =>
        serial(async () => {
          try {
            const list = await unreadChats()
            return ok(list.length ? `Unread chats:\n${list.join('\n')}` : 'No unread WhatsApp messages.')
          } catch (err) {
            return fail(err)
          }
        }),
    ),
    tool(
      'read_chat',
      'Read the most recent messages in a WhatsApp chat (group messages show who sent each). ' +
        'For "what did the CSE group say about the assignment", read 40 or so and summarise, ' +
        'picking out deadlines and anything asked of the user.',
      { contact: contactArg, count: z.number().optional().describe('How many messages, default 15.') },
      ({ contact, count }) =>
        serial(async () => {
          try {
            const { name, lines } = await readChat(contact, Math.min(80, count ?? 15))
            return ok(`Chat with ${name}:\n${lines.join('\n') || '(no messages visible)'}`)
          } catch (err) {
            return fail(err)
          }
        }),
    ),
  ]

  if (allowWrites) {
    tools.push(
      tool(
        'send_message',
        'Send a WhatsApp text message to a contact or group. Picks the chat by name; if ' +
          'the name matches several, nothing is sent and the candidates are returned. ' +
          'Send exactly the words the user dictated.',
        { contact: contactArg, message: z.string() },
        ({ contact, message }) =>
          serial(async () => {
            try {
              if (!message.trim()) return fail('The message is empty.')
              const name = await sendText(contact, message)
              return ok(`Message sent to ${name}.`)
            } catch (err) {
              return fail(err)
            }
          }),
      ),
      tool(
        'send_file',
        'Send one or more files over WhatsApp to a contact or group, with an optional ' +
          'caption. Photos and videos go as media unless as_document is true; ' +
          'everything else goes as a document. Find the file first (find_files or ' +
          'explorer_selection) if you do not have its full path.',
        {
          contact: contactArg,
          files: z.string().describe('File path(s), one per line. Absolute, or e.g. "downloads\\report.pdf".'),
          caption: z.string().optional(),
          as_document: z.boolean().optional().describe('Send photos/videos as files, uncompressed.'),
        },
        ({ contact, files, caption, as_document }) =>
          serial(async () => {
            try {
              const paths = []
              for (const f of files.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
                const real = await resolveUserPath(f)
                const bad = protectedProblem(real)
                if (bad) return fail(`Refused: ${bad}.`)
                const info = await stat(real).catch(() => null)
                if (!info?.isFile()) return fail(`${basename(real)} does not exist or is a folder.`)
                if (info.size > 2 * 1024 ** 3) return fail(`${basename(real)} is over the 2 GB WhatsApp limit.`)
                paths.push(real)
              }
              if (!paths.length) return fail('No file given.')
              const name = await sendFiles(contact, paths, caption, as_document)
              return ok(`Sent ${paths.length === 1 ? basename(paths[0]) : paths.length + ' files'} to ${name}.`)
            } catch (err) {
              return fail(err)
            }
          }),
      ),
    )
  }

  return createSdkMcpServer({
    name: 'jarvis_whatsapp',
    version: '1.0.0',
    instructions: "The user's WhatsApp, through WhatsApp Web in its own Chrome window.",
    alwaysLoad: true,
    tools,
  })
}
