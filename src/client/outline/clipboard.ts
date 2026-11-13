/**
 * Clipboard helpers for the outline editor: selected subtrees → Markdown +
 * exact JSON (NODES_MIME), and clipboard payloads → tree items.
 * @module dsh-mindmap/client/outline/clipboard
 */
import { MAX_IMPORT_DEPTH, toItems, type OutlineDoc, type TreeItem } from '../../shared/model.ts'
import { parsePasted, toMarkdown } from '../../shared/markdown.ts'
import { topLevelOf } from '../../shared/ops.ts'
import { NODES_MIME } from './helpers.ts'

/** Max nodes accepted from a NODES_MIME payload. */
const MAX_PASTE_NODES = 20000

/** Selected subtrees (top-level only, outline order) as tree items. */
export function selectionItems(doc: OutlineDoc, ids: readonly string[]): TreeItem[] {
  return toItems(doc, topLevelOf(doc, ids))
}

/** Selected subtrees as an indented Markdown list (notes as '> ' lines). */
export function selectionMarkdown(doc: OutlineDoc, ids: readonly string[]): string {
  const top = topLevelOf(doc, ids)
  const virt: OutlineDoc = { ...doc, nodes: { ...doc.nodes, __copy: { id: '__copy', text: '', children: top } } }
  return toMarkdown(virt, '__copy', null)
}

function toItem(v: unknown, depth: number, count: { n: number }): TreeItem | null {
  if (depth > MAX_IMPORT_DEPTH || typeof v !== 'object' || v === null || Array.isArray(v)) return null
  if (++count.n > MAX_PASTE_NODES) return null
  const o = v as Record<string, unknown>
  if (typeof o.text !== 'string') return null
  const kids = o.children === undefined ? [] : o.children
  if (!Array.isArray(kids)) return null
  const out: TreeItem = { text: o.text.replace(/\r\n?/g, '\n'), children: [] }
  if (typeof o.checked === 'boolean') out.checked = o.checked
  if (typeof o.note === 'string' && o.note.length > 0) out.note = o.note.replace(/\r\n?/g, '\n')
  for (const k of kids) {
    const c = toItem(k, depth + 1, count)
    if (c === null) return null
    out.children.push(c)
  }
  return out
}

/** Parse a NODES_MIME payload; null when it is not a valid non-empty TreeItem[]. */
export function parseNodesJson(raw: string): TreeItem[] | null {
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (!Array.isArray(v) || v.length === 0) return null
  const count = { n: 0 }
  const out: TreeItem[] = []
  for (const x of v) {
    const it = toItem(x, 1, count)
    if (it === null) return null
    out.push(it)
  }
  return out
}

/**
 * Items from a clipboard payload. NODES_MIME wins; otherwise text/plain is
 * parsed (Markdown or indentation). With 'multiLineOnly' (pasting inside a
 * node's text) single-line text and a lone flat line yield null so the
 * browser's default paste runs.
 */
export function clipboardItems(getData: (type: string) => string, multiLineOnly: boolean): TreeItem[] | null {
  const json = getData(NODES_MIME)
  if (json.length > 0) {
    const items = parseNodesJson(json)
    if (items !== null) return items
  }
  const text = getData('text/plain').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  if (text.trim().length === 0) return null
  if (multiLineOnly && !text.includes('\n')) return null
  const items = parsePasted(text)
  if (items.length === 0) return null
  if (multiLineOnly && items.length === 1 && items[0]!.children.length === 0 && items[0]!.note === undefined) return null
  return items
}
