/**
 * The single tree data model shared by the outline editor, the mind map and
 * the host store. Nodes live in a flat map; each node owns an ordered child-id
 * array. Ids are stable for the life of a node: moves, merges and undo never
 * re-key a node.
 * @module dsh-mindmap/shared/model
 */

/** One outline node. `checked`: undefined/null = plain node, boolean = checklist item. */
export interface OutlineNode {
  id: string
  text: string
  children: string[]
  collapsed?: boolean
  checked?: boolean | null
}

/** A whole document. The root node is invisible; its children are the top level. */
export interface OutlineDoc {
  schema: 1
  id: string
  title: string
  rootId: string
  nodes: Record<string, OutlineNode>
  revision: number
  createdAt: number
  updatedAt: number
}

/** Library row for one document. */
export interface DocMeta {
  id: string
  title: string
  folderId: string | null
  favorite: boolean
  createdAt: number
  updatedAt: number
  trashedAt?: number
}

/** One flat folder. */
export interface Folder {
  id: string
  name: string
  createdAt: number
}

/** The library index (documents are stored separately). */
export interface Library {
  schema: 1
  folders: Folder[]
  docs: DocMeta[]
}

/** A parsed import item (Markdown / OPML / paste). */
export interface TreeItem {
  text: string
  checked?: boolean | null
  children: TreeItem[]
}

/** Id shape accepted by the host routes. */
export const ID_RE = /^[a-z0-9-]{6,64}$/

/** Max title length. */
export const MAX_TITLE = 200

let counter = 0

/** A new stable, URL-safe id (time + counter + random). */
export function newId(): string {
  counter = (counter + 1) % 1296
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0')
  return `${Date.now().toString(36)}-${counter.toString(36).padStart(2, '0')}${rand}`
}

/** Clamp and clean a document title. */
export function normalizeTitle(raw: unknown, fallback = '未命名文档'): string {
  const text = typeof raw === 'string' ? raw.replace(/[\r\n\t]+/g, ' ').trim() : ''
  return (text.length > 0 ? text : fallback).slice(0, MAX_TITLE)
}

/** Build a fresh document holding `items` (or one empty node when none). */
export function createDoc(title: string, now: number, items: TreeItem[] = [], id = newId()): OutlineDoc {
  const rootId = newId()
  const nodes: Record<string, OutlineNode> = {}
  const build = (item: TreeItem): string => {
    const nid = newId()
    const node: OutlineNode = { id: nid, text: item.text, children: [] }
    if (typeof item.checked === 'boolean') node.checked = item.checked
    nodes[nid] = node
    node.children = item.children.map(build)
    return nid
  }
  const top = (items.length > 0 ? items : [{ text: '', children: [] }]).map(build)
  nodes[rootId] = { id: rootId, text: '', children: top }
  return { schema: 1, id, title: normalizeTitle(title), rootId, nodes, revision: 0, createdAt: now, updatedAt: now }
}

/** Child → parent id map. */
export function parentMap(doc: OutlineDoc): Record<string, string> {
  const parents: Record<string, string> = {}
  for (const node of Object.values(doc.nodes)) for (const child of node.children) parents[child] = node.id
  return parents
}

/**
 * Structural invariant check: the root exists, every node is reachable from
 * the root exactly once (no cycles, no shared children, no orphans) and every
 * child reference resolves. Returns an error message, or null when valid.
 */
export function validateDoc(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'document is not an object'
  const doc = value as OutlineDoc
  if (doc.schema !== 1) return 'unsupported schema'
  if (typeof doc.id !== 'string' || !ID_RE.test(doc.id)) return 'invalid document id'
  if (typeof doc.title !== 'string') return 'invalid title'
  if (typeof doc.revision !== 'number' || !Number.isInteger(doc.revision) || doc.revision < 0) return 'invalid revision'
  if (typeof doc.nodes !== 'object' || doc.nodes === null) return 'invalid nodes'
  const root = doc.nodes[doc.rootId]
  if (root === undefined) return 'root node missing'
  const seen = new Set<string>()
  const stack = [doc.rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) return `node ${id} is referenced more than once`
    seen.add(id)
    const node = doc.nodes[id]
    if (node === undefined) return `dangling child reference ${id}`
    if (node.id !== id) return `node key mismatch ${id}`
    if (typeof node.text !== 'string') return `node ${id} has no text`
    if (!Array.isArray(node.children)) return `node ${id} has no children array`
    for (const child of node.children) {
      if (typeof child !== 'string') return `node ${id} has a non-string child`
      stack.push(child)
    }
  }
  const total = Object.keys(doc.nodes).length
  if (seen.size !== total) return `${total - seen.size} orphan node(s)`
  return null
}

/** Depth-first ids under `rootId` (excluded), honoring collapse when `visibleOnly`. */
export function flatten(doc: OutlineDoc, rootId: string, visibleOnly: boolean): Array<{ id: string; depth: number }> {
  const out: Array<{ id: string; depth: number }> = []
  const walk = (id: string, depth: number): void => {
    const node = doc.nodes[id]
    if (node === undefined) return
    for (const child of node.children) {
      out.push({ id: child, depth })
      const c = doc.nodes[child]
      if (c !== undefined && (!visibleOnly || !c.collapsed)) walk(child, depth + 1)
    }
  }
  walk(rootId, 0)
  return out
}

/** Ancestors of `id` from the root down (root first, `id` excluded). */
export function ancestors(doc: OutlineDoc, id: string): string[] {
  const parents = parentMap(doc)
  const chain: string[] = []
  let cur = parents[id]
  while (cur !== undefined) {
    chain.unshift(cur)
    cur = parents[cur]
  }
  return chain
}

/** Whether `id` lies in the subtree of `ancestorId` (inclusive). */
export function isInSubtree(doc: OutlineDoc, ancestorId: string, id: string): boolean {
  if (ancestorId === id) return true
  return ancestors(doc, id).includes(ancestorId)
}

/** Count nodes excluding the root. */
export function countNodes(doc: OutlineDoc): number {
  return Object.keys(doc.nodes).length - 1
}

/** Convert a subtree into plain import items (for copy / export). */
export function toItems(doc: OutlineDoc, ids: readonly string[]): TreeItem[] {
  return ids.map(id => {
    const node = doc.nodes[id]!
    const item: TreeItem = { text: node.text, children: toItems(doc, node.children) }
    if (typeof node.checked === 'boolean') item.checked = node.checked
    return item
  })
}
