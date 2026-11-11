// One-off: download the interface's fonts into public/fonts so JARVIS looks
// right offline. Writes public/fonts/fonts.css (@font-face rules pointing at
// the local .woff2 files). Run with `node scripts/fetch-fonts.mjs`.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts')
const FAMILIES =
  'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;600;700' +
  '&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@300;400;500' +
  '&family=Chakra+Petch:wght@300;400;600&display=swap'
// A modern browser's user agent, so Google serves woff2.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

mkdirSync(OUT, { recursive: true })
let css = await (await fetch(FAMILIES, { headers: { 'user-agent': UA } })).text()
// Keep only the Latin subsets: what English text needs, a fraction of the size.
const blocks = css.split('/* ').filter((b) => b.startsWith('latin */'))
let n = 0
const local = []
for (const block of blocks) {
  const url = block.match(/url\((https:[^)]+)\)/)?.[1]
  const family = block.match(/font-family: '([^']+)'/)?.[1]
  const weight = block.match(/font-weight: (\d+)/)?.[1]
  if (!url || !family || !weight) continue
  const file = `${family.replace(/\s+/g, '')}-${weight}.woff2`
  writeFileSync(join(OUT, file), Buffer.from(await (await fetch(url)).arrayBuffer()))
  local.push(block.replace(url, file).replace(/^latin \*\/\s*/, ''))
  n++
}
writeFileSync(
  join(OUT, 'fonts.css'),
  '/* The interface fonts, stored locally so JARVIS looks right offline.\n' +
    '   Made by scripts/fetch-fonts.mjs (Google Fonts, Latin subset; SIL Open Font License). */\n' +
    local.join('\n'),
)
console.log(`saved ${n} font files to ${OUT}`)
