// Tests for the newer bridge features: customisation checks, the conversation
// journal, attachments, PDF formatting and the customisation policy. Run with
// `npm test` (node --test), alongside the security tests in this folder.
//
// The journal is pointed at a throwaway home folder before it is loaded, so
// these never touch the real ~/.jarvis.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'jarvis-test-'))
process.env.USERPROFILE = home
process.env.HOME = home

const { onlyGoogleFonts, layoutProblems } = await import('../bridge/customize.mjs')
const journal = await import('../bridge/journal.mjs')
const { composeWithAttachments, tidyAttached } = await import('../bridge/attachments.mjs')
const { markdownToHtml } = await import('../bridge/documents.mjs')
const { decideTool } = await import('../bridge/policy.mjs')

test.after(() => rmSync(home, { recursive: true, force: true }))

test('Google Fonts imports are allowed, anything else is refused', () => {
  assert.equal(onlyGoogleFonts("@import url('https://fonts.googleapis.com/css2?family=Inter');"), true)
  assert.equal(onlyGoogleFonts('@import url(https://fonts.googleapis.com/css2?family=Inter);'), true)
  assert.equal(onlyGoogleFonts('@import "https://fonts.googleapis.com/css2?family=Inter";'), true)
  assert.equal(onlyGoogleFonts('body { color: red }'), true)
  assert.equal(onlyGoogleFonts("@import url('https://evil.example/x.css');"), false)
  assert.equal(onlyGoogleFonts("@import url('https://fonts.googleapis.com/a'); @import 'http://x.y/z.css';"), false)
})

test('a layout may only import react, the kit and its stylesheet', () => {
  const ok =
    "import { useState } from 'react'\nimport { useNow } from './kit'\nimport './custom-layout.css'\n" +
    'export const hide = []\nexport default function L() { return null }'
  assert.deepEqual(layoutProblems(ok), [])
  assert.match(layoutProblems(ok.replace("from 'react'", "from 'node:fs'")).join(' '), /not allowed/)
  assert.match(layoutProblems(ok + "\nfetch('https://x')").join(' '), /may not/)
  assert.match(layoutProblems(ok.replace('export const hide = []', '')).join(' '), /hide/)
})

test('the journal records, searches and forgets exchanges', () => {
  journal.record({ user: 'open Eclipse for me', reply: 'Eclipse is open, sir.', tools: ['open app'] })
  journal.record({ user: 'make an abstract of this page as a PDF', reply: 'Saved it, sir.', tools: ['make pdf'] })
  journal.record({ user: 'remind me about the DBMS lab', reply: 'Six this evening, sir.' })
  assert.equal(journal.readHistory().length, 3)
  assert.match(journal.journalPrompt(), /open Eclipse for me/)
  const hits = journal.searchHistory('pdf abstract')
  assert.equal(hits.length, 1)
  assert.match(hits[0], /abstract/)
  assert.equal(journal.forgetHistory('dbms'), 1)
  assert.equal(journal.readHistory().length, 2)
})

test('attachments are listed for the model and tidied for people', () => {
  const msg = composeWithAttachments('summarise this', {
    items: [{ name: 'notes.pdf', path: 'C:\\tmp\\notes.pdf', note: 'PDF' }],
    problems: [],
  })
  assert.match(msg, /\[Attached files: notes\.pdf\]/)
  assert.match(msg, /C:\\tmp\\notes\.pdf/)
  assert.equal(tidyAttached(msg), 'summarise this 📎 notes.pdf')
  assert.equal(composeWithAttachments('hello', { items: [], problems: [] }), 'hello')
})

test('PDF markdown becomes headings, lists and paragraphs, and is escaped', () => {
  const html = markdownToHtml('## Key points\n- one\n- two\n\nA **bold** line.')
  assert.match(html, /<h2>Key points<\/h2>/)
  assert.match(html, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/)
  assert.match(html, /<strong>bold<\/strong>/)
  assert.doesNotMatch(markdownToHtml('<script>x</script>'), /<script>/)
})

test('customisation tools that rewrite files need write access', () => {
  for (const t of ['ui_style_apply', 'ui_layout_apply', 'ui_layout_reset']) {
    assert.equal(decideTool(`mcp__jarvis_custom__${t}`, false), false)
    assert.equal(decideTool(`mcp__jarvis_custom__${t}`, true), true)
  }
  for (const t of ['ui_layout_inspect', 'voice_analyze', 'voice_set']) {
    assert.equal(decideTool(`mcp__jarvis_custom__${t}`, false), true)
  }
})
