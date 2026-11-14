/**
 * Thumbs up / thumbs down on answers in the chat view.
 *
 * Each vote is a line in ~/.jarvis/feedback.jsonl:
 *   {"at":"2026-11-14T13:20:00.000Z","vote":"down","request":"…","reply":"…","reason":"too long"}
 * A vote can be changed or taken back (vote: null). Recent thumbs-down notes
 * reach the system prompt, so JARVIS stops repeating what was disliked.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const FILE = join(homedir(), '.jarvis', 'feedback.jsonl')

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

export function recordFeedback({ vote, request, reply, reason }) {
  if (vote !== 'up' && vote !== 'down' && vote !== null) throw new Error('vote must be up, down or null')
  if (!existsSync(dirname(FILE))) mkdirSync(dirname(FILE), { recursive: true })
  const line = { at: new Date().toISOString(), vote, request: clip(request, 600), reply: clip(reply, 1500), reason: clip(reason, 400) || undefined }
  appendFileSync(FILE, JSON.stringify(line) + '\n')
}

/** The latest vote per answer (later lines override earlier ones). */
function latest() {
  let lines = []
  try {
    lines = readFileSync(FILE, 'utf8').split('\n').filter(Boolean).slice(-400)
  } catch {
    return []
  }
  const byReply = new Map()
  for (const l of lines) {
    try {
      const f = JSON.parse(l)
      byReply.set(f.reply, f)
    } catch {
      /* skip a damaged line */
    }
  }
  return [...byReply.values()].filter((f) => f.vote)
}

/** For the system prompt: the last few answers the user disliked, and why. */
export function feedbackPrompt() {
  const downs = latest()
    .filter((f) => f.vote === 'down')
    .slice(-5)
  if (!downs.length) return ''
  const items = downs.map((f) => `- Asked "${clip(f.request, 120)}" → disliked${f.reason ? `: ${clip(f.reason, 160)}` : ''}`)
  return `\n\nRecent answers the user marked as bad (avoid the same mistakes):\n${items.join('\n')}\n`
}
