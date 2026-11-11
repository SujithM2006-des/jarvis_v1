// Your own look lives in three files JARVIS rewrites when you ask him to
// restyle himself (src/custom/CustomLayout.tsx, custom-layout.css,
// user-theme.css). They are yours, so git leaves them alone (.gitignore);
// the project ships a default of each (*.default.*). Any that is missing — a
// fresh clone, a deleted file — is made from its default. Run by start.mjs and
// by `npm install` (postinstall); safe to run any time, it never overwrites.

import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CUSTOM = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'custom')
const FILES = [
  ['CustomLayout.default.tsx', 'CustomLayout.tsx'],
  ['custom-layout.default.css', 'custom-layout.css'],
  ['user-theme.default.css', 'user-theme.css'],
]

export function ensureCustom() {
  const made = []
  for (const [from, to] of FILES) {
    const target = join(CUSTOM, to)
    if (!existsSync(target) && existsSync(join(CUSTOM, from))) {
      copyFileSync(join(CUSTOM, from), target)
      made.push(to)
    }
  }
  return made
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const made = ensureCustom()
  console.log(made.length ? `made from defaults: ${made.join(', ')}` : 'custom look files present')
}
