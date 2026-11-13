/**
 * Markdown import/export. Export is a nested "- " list (2-space indent,
 * continuation lines indented under the item, checklist as [ ] / [x], notes as
 * "> " quote lines under the item) under a "# title" heading; import accepts
 * that plus -,*,+,1. lists, # headings as levels, tab/2/4-space indents, plain
 * indented text (for paste), fenced code blocks and paragraphs (kept as notes).
 * Export → import is lossless for text, notes, order, nesting and checklist state.
 * @module dsh-mindmap/shared/markdown
 */
import type { OutlineDoc, TreeItem } from './model.ts'

/** Export a (sub)tree as Markdown. */
export function toMarkdown(doc: OutlineDoc, rootId: string = doc.rootId, title: string | null = doc.title): string {
  const lines: string[] = []
  if (title !== null && title.length > 0) lines.push(`# ${title}`, '')
  const stack: Array<[string, number]> = []
  const top = doc.nodes[rootId]?.children ?? []
  for (let i = top.length - 1; i >= 0; i--) stack.push([top[i]!, 0])
  while (stack.length > 0) {
    const [id, depth] = stack.pop()!
    const n = doc.nodes[id]
    if (n === undefined) continue
    const pad = '  '.repeat(depth)
    const box = n.checked === true ? '[x] ' : n.checked === false ? '[ ] ' : ''
    const [first = '', ...rest] = n.text.split('\n')
    const head = `${pad}- ${box}${escapeFirst(first)}`
    lines.push(first.length === 0 && box.length === 0 ? `${pad}-` : head)
    for (const line of rest) lines.push(`${pad}  ${escapeRest(line)}`)
    if (typeof n.note === 'string' && n.note.length > 0) {
      for (const line of n.note.split('\n')) lines.push(line.length > 0 ? `${pad}  > ${line}` : `${pad}  >`)
    }
    for (let i = n.children.length - 1; i >= 0; i--) stack.push([n.children[i]!, depth + 1])
  }
  return lines.join('\n') + '\n'
}

/**
 * Text that would otherwise be re-read as markup is escaped: leading spaces
 * of an item become &#32; (rendered as spaces) and a leading checkbox gets a
 * backslash; continuation lines that look like a list item, heading, quote or
 * fence get a backslash. The parser undoes exactly these escapes.
 */
function escapeFirst(text: string): string {
  const lead = /^ +/.exec(text)?.[0].length ?? 0
  const body = text.slice(lead)
  return '&#32;'.repeat(lead) + (lead === 0 && /^\[( |x|X)\]/.test(body) ? '\\' : '') + body
}

function needsEscape(t: string): boolean {
  return LIST_RE.test(t) || HEADING_RE.test(t) || t.startsWith('\\') || t.startsWith('>') || FENCE_RE.test(t)
}

function escapeRest(line: string): string {
  const t = line.trimStart()
  return t.length > 0 && needsEscape(t) ? line.slice(0, line.length - t.length) + '\\' + t : line
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
  return needsEscape(u) ? line.slice(0, line.length - t.length) + u : line
}

/** Parsed Markdown. */
export interface ParsedMarkdown {
  title?: string
  items: TreeItem[]
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const CHECK_RE = /^\[( |x|X)\](?:\s+|$)([\s\S]*)$/
const FENCE_RE = /^(```+|~~~+)/
const QUOTE_RE = /^>\s?(.*)$/

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function addNote(item: TreeItem, text: string, blanks: number): void {
  item.note = item.note === undefined ? text : item.note + '\n'.repeat(blanks > 0 ? 2 : 1) + text
}

/** Parse Markdown into tree items. A lone leading H1 becomes the title. */
export function parseMarkdown(src: string, options: { detectTitle?: boolean } = {}): ParsedMarkdown {
  const detectTitle = options.detectTitle ?? true
  const lines = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\t/g, '    '))
  // Pre-scan with fence tracking so a '# x' inside a code block is not an H1.
  let h1Count = 0
  {
    let fence: string | null = null
    for (const l of lines) {
      const fm = FENCE_RE.exec(l.trimStart())
      if (fence !== null) { if (fm !== null && fm[1]!.startsWith(fence)) fence = null; continue }
      if (fm !== null) { fence = fm[1]!; continue }
      if (/^#\s+\S/.test(l)) h1Count++
    }
  }
  const root: TreeItem[] = []
  const headings: Array<{ level: number; item: TreeItem }> = []
  let list: Array<{ indent: number; item: TreeItem }> = []
  let last: { marker: number; content: number; item: TreeItem } | null = null
  // Heading that has not received content yet: following paragraphs become its note.
  let freshHeading: TreeItem | null = null
  let blanks = 0
  let title: string | undefined
  const container = (): TreeItem[] => (headings.length > 0 ? headings[headings.length - 1]!.item.children : root)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim().length === 0) { blanks++; continue }
    const ind = indentOf(line)
    const trimmed = line.slice(ind)
    const fm = FENCE_RE.exec(trimmed)
    if (fm !== null) {
      // Collect the whole block verbatim (dedented by the fence indent).
      const block: string[] = [trimmed]
      let j = i + 1
      for (; j < lines.length; j++) {
        const l = lines[j]!
        const body = l.slice(Math.min(ind, indentOf(l)))
        block.push(body)
        const close = FENCE_RE.exec(l.trimStart())
        if (close !== null && close[1]!.startsWith(fm[1]!) && l.trimStart().slice(close[1]!.length).trim().length === 0) break
      }
      i = j
      const text = block.join('\n')
      const owner = last !== null && ind > last.marker ? last.item : freshHeading ?? last?.item ?? null
      if (owner !== null) addNote(owner, text, blanks)
      else container().push({ text, children: [] })
      blanks = 0
      continue
    }
    const hm = HEADING_RE.exec(line)
    if (hm !== null) {
      const level = hm[1]!.length
      if (detectTitle && title === undefined && level === 1 && h1Count === 1 && root.length === 0) {
        title = hm[2]!
        freshHeading = null
      } else {
        while (headings.length > 0 && headings[headings.length - 1]!.level >= level) headings.pop()
        const item: TreeItem = { text: hm[2]!, children: [] }
        container().push(item)
        headings.push({ level, item })
        freshHeading = item
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
      freshHeading = null
      blanks = 0
      continue
    }
    const qm = QUOTE_RE.exec(trimmed)
    if (last !== null && ind > last.marker) {
      if (qm !== null) addNote(last.item, qm[1]!, 0)
      else last.item.text += '\n'.repeat(blanks + 1) + unescapeRest(line.slice(Math.min(ind, last.content)))
      blanks = 0
      continue
    }
    const para = qm !== null ? qm[1]! : trimmed
    if (freshHeading !== null) {
      addNote(freshHeading, para, blanks)
      blanks = 0
      continue
    }
    container().push({ text: para, children: [] })
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
