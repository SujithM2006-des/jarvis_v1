import DOMPurify from 'dompurify'

/**
 * Markdown to HTML for the chat view: headings, paragraphs, bold, italic,
 * inline code, fenced code blocks (with a language label), lists, quotes,
 * tables, rules and links. Everything is escaped first and only a fixed set of
 * tags is ever produced; DOMPurify checks the result again on the way out.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Inline marks on an already-escaped line. Code spans are protected first. */
function inline(s: string): string {
  const codes: string[] = []
  s = s.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(c)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`)
}

export function renderMarkdown(src: string): string {
  const lines = esc(src.replace(/\r\n/g, '\n')).split('\n')
  const out: string[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Fenced code: kept verbatim (already escaped). An unclosed fence (still
    // streaming) runs to the end.
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i])
      out.push(`<pre data-lang="${fence[1] || 'text'}"><code>${code.join('\n')}</code></pre>`)
      continue
    }

    if (!line.trim()) {
      flush()
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      const n = Math.min(4, h[1].length + 1)
      out.push(`<h${n}>${inline(h[2])}</h${n}>`)
      continue
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      out.push('<hr>')
      continue
    }

    if (/^&gt;\s?/.test(line)) {
      flush()
      const q: string[] = []
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) q.push(lines[i++].replace(/^&gt;\s?/, ''))
      i--
      out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`)
      continue
    }

    // Lists (nested items are marked with a class and indented).
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      flush()
      const ordered = /\d/.test(li[2])
      const items: string[] = []
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (!m) {
          // A wrapped continuation of the item above.
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
            items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, ` ${inline(lines[i].trim())}</li>`)
            i++
            continue
          }
          break
        }
        const task = /^\[( |x)\]\s+(.*)$/i.exec(m[3])
        const body = task ? `<input type="checkbox" disabled${task[1].trim() ? ' checked' : ''}> ${inline(task[2])}` : inline(m[3])
        items.push(`<li${m[1].length >= 2 ? ' class="md-sub"' : ''}>${body}</li>`)
        i++
      }
      i--
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }

    // Tables: a header row, a |---| row, then rows.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush()
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()))
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      i--
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      )
      continue
    }

    para.push(line.trim())
  }
  flush()

  return DOMPurify.sanitize(out.join(''), {
    ALLOWED_TAGS: ['p', 'h2', 'h3', 'h4', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'input', 'br'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'data-lang', 'class', 'type', 'disabled', 'checked'],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
  })
}

/** Does this reply read as written content (worth the chat view), not a spoken line? */
export function isLongForm(text: string): boolean {
  const t = text.trim()
  if (t.length > 420) return true
  if (/```/.test(t)) return true
  if (/(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|.*\|)/.test(t) && t.split('\n').length >= 3) return true
  return t.split(/\n\s*\n/).length >= 3
}

/** A typed request that asks for written output ("write…", "generate…", "explain…"). */
export const ASKS_FOR_TEXT =
  /\b(write|generate|draft|compose|create|list|explain|describe|summari[sz]e|outline|code|script|essay|article|story|poem|email|letter|caption|report|notes|steps|guide|tutorial|translate|rewrite|compare|analy[sz]e|ideas|table)\b/i
