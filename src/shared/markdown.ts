/**
 * Markdown import/export. Export is a nested "- " list (2-space indent,
 * continuation lines indented under the item, checklist as [ ] / [x]) under a
 * "# title" heading; import accepts that plus -,*,+,1. lists, # headings as
 * levels, tab/2/4-space indents and plain indented text (for paste).
 * Export → import is lossless for text, order, nesting and checklist state.
 * @module dsh-mindmap/shared/markdown
 */
import type { OutlineDoc, TreeItem } from './model.ts'

/** Export a (sub)tree as Markdown. */
export function toMarkdown(doc: OutlineDoc, rootId: string = doc.rootId, title: string | null = doc.title): string {
  const lines: string[] = []
  if (title !== null && title.length > 0) lines.push(`# ${title}`, '')
  const walk = (ids: readonly string[], depth: number): void => {
    for (const id of ids) {
      const n = doc.nodes[id]
      if (n === undefined) continue
      const pad = '  '.repeat(depth)
      const box = n.checked === true ? '[x] ' : n.checked === false ? '[ ] ' : ''
      const [first = '', ...rest] = n.text.split('\n')
      const head = `${pad}- ${box}${escapeFirst(first)}`
      lines.push(first.length === 0 && box.length === 0 ? `${pad}-` : head)
      for (const line of rest) lines.push(`${pad}  ${escapeRest(line)}`)
      walk(n.children, depth + 1)
    }
  }
  walk(doc.nodes[rootId]?.children ?? [], 0)
  return lines.join('\n') + '\n'
}

/**
 * Text that would otherwise be re-read as markup is escaped: leading spaces
 * of an item become &#32; (rendered as spaces) and a leading checkbox gets a
 * backslash; continuation lines that look like a list item or heading get a
 * backslash. The parser undoes exactly these escapes.
 */
function escapeFirst(text: string): string {
  const lead = /^ +/.exec(text)?.[0].length ?? 0
  const body = text.slice(lead)
  return '&#32;'.repeat(lead) + (lead === 0 && /^\[( |x|X)\]/.test(body) ? '\\' : '') + body
}

function escapeRest(line: string): string {
  const t = line.trimStart()
  return t.length > 0 && (LIST_RE.test(t) || HEADING_RE.test(t) || t.startsWith('\\')) ? line.slice(0, line.length - t.length) + '\\' + t : line
}

function unescapeFirst(text: string): string {
  const m = /^(?:&#32;)+/.exec(text)
  if (m !== null) return ' '.repeat(m[0].length / 5) + text.slice(m[0].length)
  return /^\\\[( |x|X)\]/.test(text) ? text.slice(1) : text
}

function unescapeRest(line: string): string {
  const t = line.trimStart()
  if (!t.startsWith('\\')) return line
  const u = t.slice(1)
  return LIST_RE.test(u) || HEADING_RE.test(u) || u.startsWith('\\') ? line.slice(0, line.length - t.length) + u : line
}

/** Parsed Markdown. */
export interface ParsedMarkdown {
  title?: string
  items: TreeItem[]
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const CHECK_RE = /^\[( |x|X)\](?:\s+|$)([\s\S]*)$/

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** Parse Markdown into tree items. A lone leading H1 becomes the title. */
export function parseMarkdown(src: string, options: { detectTitle?: boolean } = {}): ParsedMarkdown {
  const detectTitle = options.detectTitle ?? true
  const lines = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\t/g, '    '))
  const h1Count = lines.filter(l => /^#\s+\S/.test(l)).length
  const root: TreeItem[] = []
  const headings: Array<{ level: number; item: TreeItem }> = []
  let list: Array<{ indent: number; item: TreeItem }> = []
  let last: { marker: number; content: number; item: TreeItem } | null = null
  let blanks = 0
  let title: string | undefined
  const container = (): TreeItem[] => (headings.length > 0 ? headings[headings.length - 1]!.item.children : root)
  for (const line of lines) {
    if (line.trim().length === 0) { blanks++; continue }
    const hm = HEADING_RE.exec(line)
    if (hm !== null) {
      const level = hm[1]!.length
      if (detectTitle && title === undefined && level === 1 && h1Count === 1 && root.length === 0) {
        title = hm[2]!
      } else {
        while (headings.length > 0 && headings[headings.length - 1]!.level >= level) headings.pop()
        const item: TreeItem = { text: hm[2]!, children: [] }
        container().push(item)
        headings.push({ level, item })
      }
      list = []
      last = null
      blanks = 0
      continue
    }
    const lm = LIST_RE.exec(line)
    if (lm !== null) {
      const indent = lm[1]!.length
      let text = lm[4] ?? ''
      let checked: boolean | undefined
      const cb = CHECK_RE.exec(text)
      if (cb !== null) { checked = cb[1] !== ' '; text = cb[2]! }
      text = unescapeFirst(text)
      while (list.length > 0 && list[list.length - 1]!.indent >= indent) list.pop()
      const item: TreeItem = { text, children: [] }
      if (checked !== undefined) item.checked = checked
      ;(list.length > 0 ? list[list.length - 1]!.item.children : container()).push(item)
      list.push({ indent, item })
      last = { marker: indent, content: indent + lm[2]!.length + Math.max(1, lm[3]!.length), item }
      blanks = 0
      continue
    }
    const ind = indentOf(line)
    if (last !== null && ind > last.marker) {
      last.item.text += '\n'.repeat(blanks + 1) + unescapeRest(line.slice(Math.min(ind, last.content)))
      blanks = 0
      continue
    }
    container().push({ text: line.trim(), children: [] })
    list = []
    last = null
    blanks = 0
  }
  return title === undefined ? { items: root } : { title, items: root }
}

/** Plain text: one node per non-empty line, nesting by indentation. */
export function parseIndented(src: string): TreeItem[] {
  const root: TreeItem[] = []
  const stack: Array<{ indent: number; item: TreeItem }> = []
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\t/g, '    ')
    if (line.trim().length === 0) continue
    const indent = indentOf(line)
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop()
    const item: TreeItem = { text: line.trim(), children: [] }
    ;(stack.length > 0 ? stack[stack.length - 1]!.item.children : root).push(item)
    stack.push({ indent, item })
  }
  return root
}

/** Pasted multi-line text → items (Markdown when it looks like it, else indentation). */
export function parsePasted(src: string): TreeItem[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim().length > 0)
  const looksMd = lines.some(l => LIST_RE.test(l.replace(/\t/g, '    ')) || HEADING_RE.test(l))
  return looksMd ? parseMarkdown(src, { detectTitle: false }).items : parseIndented(src)
}
