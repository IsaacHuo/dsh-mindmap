/**
 * OPML 2.0 import/export (text attribute; _note for notes, _checked for checklist state). The
 * parser is a small tokenizer so it runs identically in the host, the browser
 * and tests.
 * @module dsh-mindmap/shared/opml
 */
import type { OutlineDoc, TreeItem } from './model.ts'

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '')
}

function unesc(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (_m, ent: string) => {
    if (ent === 'lt') return '<'
    if (ent === 'gt') return '>'
    if (ent === 'quot') return '"'
    if (ent === 'apos') return "'"
    if (ent === 'amp') return '&'
    const code = ent[1] === 'x' ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
}

/** Export a (sub)tree as OPML 2.0. */
export function toOpml(doc: OutlineDoc, rootId: string = doc.rootId, title: string = doc.title): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">', `  <head><title>${esc(title)}</title></head>`, '  <body>']
  const walk = (ids: readonly string[], depth: number): void => {
    for (const id of ids) {
      const n = doc.nodes[id]
      if (n === undefined) continue
      const pad = '  '.repeat(depth + 2)
      const note = typeof n.note === 'string' && n.note.length > 0 ? ` _note="${esc(n.note)}"` : ''
      const attrs = `text="${esc(n.text)}"${note}${typeof n.checked === 'boolean' ? ` _checked="${n.checked}"` : ''}`
      if (n.children.length === 0) out.push(`${pad}<outline ${attrs}/>`)
      else {
        out.push(`${pad}<outline ${attrs}>`)
        walk(n.children, depth + 1)
        out.push(`${pad}</outline>`)
      }
    }
  }
  walk(doc.nodes[rootId]?.children ?? [], 0)
  out.push('  </body>', '</opml>')
  return out.join('\n') + '\n'
}

/** Parse OPML into a title and items. Throws on input without an <opml> body. */
export function parseOpml(xml: string): { title?: string; items: TreeItem[] } {
  if (!/<opml[\s>]/i.test(xml)) throw new Error('不是有效的 OPML 文件')
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(xml)
  const bodyAt = xml.search(/<body[\s>\/]/i)
  const body = bodyAt >= 0 ? xml.slice(bodyAt) : xml
  const root: TreeItem[] = []
  const stack: TreeItem[] = []
  // Quote-aware: '>' inside an attribute value does not end the tag.
  const tokens = /<outline\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<\/outline\s*>/gi
  let m: RegExpExecArray | null
  while ((m = tokens.exec(body)) !== null) {
    if (m[0].startsWith('</')) { stack.pop(); continue }
    const attrs: Record<string, string> = {}
    const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let a: RegExpExecArray | null
    while ((a = attrRe.exec(m[1] ?? '')) !== null) attrs[a[1]!] = unesc(a[2] ?? a[3] ?? '')
    const item: TreeItem = { text: (attrs.text ?? attrs.title ?? '').replace(/\r/g, ''), children: [] }
    const flag = attrs._checked ?? attrs._complete
    if (flag === 'true') item.checked = true
    else if (attrs._checked === 'false') item.checked = false
    const note = (attrs._note ?? '').replace(/\r/g, '')
    if (note.trim().length > 0) item.note = note
    ;(stack.length > 0 ? stack[stack.length - 1]!.children : root).push(item)
    if (m[2] !== '/') stack.push(item)
  }
  const title = titleMatch !== null ? unesc(titleMatch[1]!.trim()) : undefined
  return title !== undefined && title.length > 0 ? { title, items: root } : { items: root }
}
