/**
 * Case-insensitive search over document titles, node text and notes. A
 * document can be reduced to a compact index (pre-order text entries) so the
 * host can search without keeping whole documents in memory.
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

/** Compact searchable form of one document. */
export interface DocIndex {
  docId: string
  revision: number
  /** Pre-order [nodeId, text, note] triples. */
  entries: Array<[string, string, string]>
}

function snippetOf(text: string, at: number, len: number): string {
  const flat = text.replace(/\s+/g, ' ')
  const start = Math.max(0, at - 24)
  const end = Math.min(flat.length, at + len + 40)
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '')
}

/** Build the index of a document (iterative pre-order). */
export function indexDoc(doc: OutlineDoc): DocIndex {
  const entries: Array<[string, string, string]> = []
  const stack = (doc.nodes[doc.rootId]?.children ?? []).slice().reverse()
  while (stack.length > 0) {
    const id = stack.pop()!
    const n = doc.nodes[id]
    if (n === undefined) continue
    entries.push([id, n.text, n.note ?? ''])
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!)
  }
  return { docId: doc.id, revision: doc.revision, entries }
}

/** Search an index; returns at most limit hits (title first, then nodes in outline order). */
export function searchIndex(index: DocIndex, title: string, query: string, limit = 20): SearchHit[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (q.length === 0 || limit <= 0) return []
  const hits: SearchHit[] = []
  const ti = title.toLowerCase().indexOf(q)
  if (ti >= 0) hits.push({ docId: index.docId, title, nodeId: null, snippet: snippetOf(title, ti, q.length) })
  for (const [id, text, note] of index.entries) {
    if (hits.length >= limit) break
    const at = text.toLowerCase().replace(/\s/g, ' ').indexOf(q)
    if (at >= 0) { hits.push({ docId: index.docId, title, nodeId: id, snippet: snippetOf(text, at, q.length) }); continue }
    const nt = note.length > 0 ? note.toLowerCase().replace(/\s/g, ' ').indexOf(q) : -1
    if (nt >= 0) hits.push({ docId: index.docId, title, nodeId: id, snippet: snippetOf(note, nt, q.length) })
  }
  return hits
}

/** Search one document; returns at most limit hits. */
export function searchDoc(doc: OutlineDoc, title: string, query: string, limit = 20): SearchHit[] {
  return searchIndex(indexDoc(doc), title, query, limit)
}
