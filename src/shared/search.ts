/**
 * Case-insensitive search over document titles and node text.
 * @module dsh-mindmap/shared/search
 */
import type { OutlineDoc } from './model.ts'

/** One hit: a title hit has nodeId null. */
export interface SearchHit {
  docId: string
  title: string
  nodeId: string | null
  snippet: string
}

function snippetOf(text: string, at: number, len: number): string {
  const flat = text.replace(/\s+/g, ' ')
  const start = Math.max(0, at - 24)
  const end = Math.min(flat.length, at + len + 40)
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '')
}

/** Search one document; returns at most `limit` hits. */
export function searchDoc(doc: OutlineDoc, title: string, query: string, limit = 20): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return []
  const hits: SearchHit[] = []
  const ti = title.toLowerCase().indexOf(q)
  if (ti >= 0) hits.push({ docId: doc.id, title, nodeId: null, snippet: snippetOf(title, ti, q.length) })
  const walk = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (hits.length >= limit) return
      const n = doc.nodes[id]
      if (n === undefined) continue
      const at = n.text.toLowerCase().replace(/\s/g, ' ').indexOf(q)
      if (at >= 0) hits.push({ docId: doc.id, title, nodeId: id, snippet: snippetOf(n.text, at, q.length) })
      walk(n.children)
    }
  }
  walk(doc.nodes[doc.rootId]?.children ?? [])
  return hits
}
