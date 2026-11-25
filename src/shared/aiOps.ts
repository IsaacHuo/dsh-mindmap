/**
 * AI edits with a paper trail. The agent tool never removes or silently
 * rewrites user content: additions are marked `added`, rewrites keep the
 * original text (`edited`), and deletions only mark the node `deleted`
 * (struck through). The user then accepts or rejects each change; only an
 * accepted deletion actually removes nodes. Pure functions shared by the host
 * tool (applyAiOps) and the UI (reviewAi / pendingAi).
 * @module dsh-mindmap/shared/aiOps
 */
import { newId, parentMap, type AiMark, type OutlineDoc, type OutlineNode, type SessionLink } from './model.ts'

/** One node to add, with optional nested children. */
export interface AiAddItem { text: string; note?: string; checked?: boolean | null; children?: AiAddItem[] }

/** One AI operation. */
export type AiOp =
  | { op: 'add'; parentId: string; index?: number; text: string; note?: string; checked?: boolean | null; children?: AiAddItem[] }
  | { op: 'edit'; nodeId: string; text?: string; note?: string; checked?: boolean | null }
  | { op: 'delete'; nodeId: string }

/** Limits for one apply call. */
export const AI_LIMITS = { ops: 200, nodes: 1000, text: 10_000 } as const

export class AiOpError extends Error {
  readonly index: number | undefined
  constructor(message: string, index?: number) {
    super(index === undefined ? message : `op #${index}: ${message}`)
    this.index = index
  }
}

export interface AiApplyResult { doc: OutlineDoc; added: string[]; edited: string[]; deleted: string[]; removed: string[] }

function subtree(nodes: Record<string, OutlineNode>, id: string): string[] {
  const out: string[] = []
  const stack = [id]
  while (stack.length > 0) {
    const cur = stack.pop()!
    out.push(cur)
    const n = nodes[cur]
    if (n !== undefined) stack.push(...n.children)
  }
  return out
}

/** Remove `id` and its subtree from a mutable nodes map. */
function removeSubtree(nodes: Record<string, OutlineNode>, parents: Record<string, string>, id: string): string[] {
  const pid = parents[id]
  if (pid !== undefined && nodes[pid] !== undefined) nodes[pid] = { ...nodes[pid]!, children: nodes[pid]!.children.filter(c => c !== id) }
  const gone = subtree(nodes, id)
  for (const g of gone) delete nodes[g]
  return gone
}

function withoutAi(n: OutlineNode): OutlineNode {
  const next = { ...n }
  delete next.ai
  return next
}

function setChecked(n: OutlineNode, checked: boolean | null | undefined): void {
  if (checked === undefined) return
  if (checked === null) delete n.checked
  else n.checked = checked
}

function setNoteField(n: OutlineNode, note: string | undefined): void {
  if (note === undefined) return
  if (note.length === 0) delete n.note
  else n.note = note
}

function text(value: unknown, what: string, index: number): string {
  if (typeof value !== 'string') throw new AiOpError(`${what} must be a string`, index)
  if (value.length > AI_LIMITS.text) throw new AiOpError(`${what} is longer than ${AI_LIMITS.text} characters`, index)
  return value.replace(/\r\n?/g, '\n')
}

function optText(value: unknown, what: string, index: number): string | undefined {
  return value === undefined ? undefined : text(value, what, index)
}

function optChecked(value: unknown, index: number): boolean | null | undefined {
  if (value === undefined || value === null || typeof value === 'boolean') return value
  throw new AiOpError('checked must be true, false or null', index)
}

/** Whether `id` or one of its ancestors is marked deleted. */
export function underDeletion(doc: OutlineDoc, id: string, parents: Record<string, string> = parentMap(doc)): boolean {
  let cur: string | undefined = id
  while (cur !== undefined) {
    if (doc.nodes[cur]?.ai?.kind === 'deleted') return true
    cur = parents[cur]
  }
  return false
}

/**
 * Apply AI operations atomically (all or nothing). Throws AiOpError on the
 * first invalid op. Returns the same doc object when nothing changed.
 */
export function applyAiOps(doc: OutlineDoc, opsIn: readonly unknown[], ctx: { now: number; sessionId?: string }): AiApplyResult {
  if (!Array.isArray(opsIn) || opsIn.length === 0) throw new AiOpError('ops must be a non-empty array')
  if (opsIn.length > AI_LIMITS.ops) throw new AiOpError(`at most ${AI_LIMITS.ops} ops per call`)
  const nodes: Record<string, OutlineNode> = { ...doc.nodes }
  const parents = parentMap(doc)
  const res = { added: [] as string[], edited: [] as string[], deleted: [] as string[], removed: [] as string[] }
  const mark = (kind: AiMark['kind'], extra: Partial<AiMark> = {}): AiMark => {
    const m: AiMark = { kind, at: ctx.now, ...extra }
    if (ctx.sessionId !== undefined) m.sessionId = ctx.sessionId
    return m
  }
  const view = (): OutlineDoc => ({ ...doc, nodes })
  let created = 0
  let changed = false

  const build = (item: AiAddItem, index: number, depth: number): string => {
    if (depth > 50) throw new AiOpError('children nested deeper than 50 levels', index)
    if (++created > AI_LIMITS.nodes) throw new AiOpError(`at most ${AI_LIMITS.nodes} new nodes per call`, index)
    const n: OutlineNode = { id: newId(), text: text(item.text, 'text', index), children: [], ai: mark('added') }
    setNoteField(n, optText(item.note, 'note', index))
    setChecked(n, optChecked(item.checked, index))
    nodes[n.id] = n
    res.added.push(n.id)
    if (item.children !== undefined) {
      if (!Array.isArray(item.children)) throw new AiOpError('children must be an array', index)
      for (const c of item.children) {
        const cid = build(c as AiAddItem, index, depth + 1)
        parents[cid] = n.id
        n.children.push(cid)
      }
    }
    return n.id
  }

  opsIn.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) throw new AiOpError('op must be an object', index)
    const op = raw as Record<string, unknown>
    switch (op.op) {
      case 'add': {
        const pid = op.parentId
        if (typeof pid !== 'string' || nodes[pid] === undefined) throw new AiOpError(`unknown parentId ${String(pid)}`, index)
        if (underDeletion(view(), pid, parents)) throw new AiOpError('cannot add under a node pending deletion', index)
        const id = build(op as unknown as AiAddItem, index, 0)
        const parent = nodes[pid]!
        const children = parent.children.slice()
        const at = typeof op.index === 'number' && Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, children.length)) : children.length
        children.splice(at, 0, id)
        nodes[pid] = { ...parent, children, collapsed: false }
        parents[id] = pid
        changed = true
        return
      }
      case 'edit': {
        const id = op.nodeId
        if (typeof id !== 'string' || nodes[id] === undefined) throw new AiOpError(`unknown nodeId ${String(id)}`, index)
        if (id === doc.rootId) throw new AiOpError('the root node cannot be edited; rename the document instead', index)
        const cur = nodes[id]!
        if (cur.ai?.kind === 'deleted') throw new AiOpError('node is pending deletion; it cannot be edited', index)
        const t = optText(op.text, 'text', index)
        const note = optText(op.note, 'note', index)
        const checked = optChecked(op.checked, index)
        if (t === undefined && note === undefined && checked === undefined) throw new AiOpError('edit needs text, note or checked', index)
        const next: OutlineNode = { ...cur }
        if (t !== undefined) next.text = t
        setNoteField(next, note)
        setChecked(next, checked)
        const same = next.text === cur.text && (next.note ?? '') === (cur.note ?? '') && (next.checked ?? null) === (cur.checked ?? null)
        if (same) return
        if (cur.ai === undefined) {
          next.ai = mark('edited', { prevText: cur.text, prevNote: cur.note ?? '', prevChecked: cur.checked ?? null })
        } else if (cur.ai.kind === 'edited') {
          const back = next.text === cur.ai.prevText && (next.note ?? '') === (cur.ai.prevNote ?? '') && (next.checked ?? null) === (cur.ai.prevChecked ?? null)
          if (back) delete next.ai
          else next.ai = { ...cur.ai, at: ctx.now }
        }
        nodes[id] = next
        if (!res.edited.includes(id)) res.edited.push(id)
        changed = true
        return
      }
      case 'delete': {
        const id = op.nodeId
        if (typeof id !== 'string' || nodes[id] === undefined) throw new AiOpError(`unknown nodeId ${String(id)}`, index)
        if (id === doc.rootId) throw new AiOpError('the root node cannot be deleted', index)
        const cur = nodes[id]!
        if (cur.ai?.kind === 'deleted') return
        if (cur.ai?.kind === 'added') {
          // It never existed for the user: drop it outright.
          res.removed.push(...removeSubtree(nodes, parents, id))
        } else {
          const extra: Partial<AiMark> = cur.ai?.kind === 'edited' ? { prevText: cur.ai.prevText, prevNote: cur.ai.prevNote, prevChecked: cur.ai.prevChecked } : {}
          nodes[id] = { ...cur, ai: mark('deleted', extra) }
          res.deleted.push(id)
        }
        changed = true
        return
      }
      default:
        throw new AiOpError(`unsupported op ${JSON.stringify(op.op)} (use add, edit or delete)`, index)
    }
  })
  const clean = (ids: string[]): string[] => ids.filter(id => nodes[id] !== undefined)
  return { doc: changed ? view() : doc, added: clean(res.added), edited: clean(res.edited), deleted: clean(res.deleted), removed: res.removed }
}

/** Accept or reject the pending AI changes on `ids` (ids without a mark are skipped). */
export function reviewAi(doc: OutlineDoc, ids: readonly string[], decision: 'accept' | 'reject'): OutlineDoc {
  const nodes: Record<string, OutlineNode> = { ...doc.nodes }
  const parents = parentMap(doc)
  let changed = false
  for (const id of ids) {
    const n = nodes[id]
    if (n === undefined || n.ai === undefined || id === doc.rootId) continue
    const { kind } = n.ai
    changed = true
    if ((decision === 'accept' && kind === 'deleted') || (decision === 'reject' && kind === 'added')) {
      removeSubtree(nodes, parents, id)
      continue
    }
    if (decision === 'reject' && n.ai.prevText !== undefined) {
      const next = withoutAi(n)
      next.text = n.ai.prevText
      setNoteField(next, n.ai.prevNote ?? '')
      setChecked(next, n.ai.prevChecked === undefined ? undefined : n.ai.prevChecked)
      nodes[id] = next
      continue
    }
    nodes[id] = withoutAi(n)
  }
  return changed ? { ...doc, nodes } : doc
}

/** Every pending AI change in document order. */
export function pendingAi(doc: OutlineDoc): Array<{ id: string; kind: AiMark['kind'] }> {
  const out: Array<{ id: string; kind: AiMark['kind'] }> = []
  const stack = [...(doc.nodes[doc.rootId]?.children ?? [])].reverse()
  while (stack.length > 0) {
    const id = stack.pop()!
    const n = doc.nodes[id]
    if (n === undefined) continue
    if (n.ai !== undefined) out.push({ id, kind: n.ai.kind })
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!)
  }
  return out
}

/** Bind a conversation to a node (most recent first; idempotent). */
export function bindSession(doc: OutlineDoc, nodeId: string, link: SessionLink): OutlineDoc {
  const n = doc.nodes[nodeId]
  if (n === undefined) return doc
  const rest = (n.sessions ?? []).filter(s => s.id !== link.id)
  return { ...doc, nodes: { ...doc.nodes, [nodeId]: { ...n, sessions: [link, ...rest].slice(0, 20) } } }
}

/** Unbind a conversation from a node (the conversation itself is kept). */
export function unbindSession(doc: OutlineDoc, nodeId: string, sessionId: string): OutlineDoc {
  const n = doc.nodes[nodeId]
  if (n === undefined || !(n.sessions ?? []).some(s => s.id === sessionId)) return doc
  const sessions = (n.sessions ?? []).filter(s => s.id !== sessionId)
  const next = { ...n }
  if (sessions.length > 0) next.sessions = sessions
  else delete next.sessions
  return { ...doc, nodes: { ...doc.nodes, [nodeId]: next } }
}

/** Find a node bound to `sessionId` in a document. */
export function nodeForSession(doc: OutlineDoc, sessionId: string): string | undefined {
  for (const n of Object.values(doc.nodes)) if (n.sessions?.some(s => s.id === sessionId) === true) return n.id
  return undefined
}

/** `mindmap://<docId>/<nodeId>` reference used in prompts and the agent tool. */
export function nodeRef(docId: string, nodeId?: string): string {
  return 'mindmap://' + docId + (nodeId !== undefined ? '/' + nodeId : '')
}

/** Parse a `mindmap://doc[/node]` reference. */
export function parseRef(ref: string): { docId: string; nodeId?: string } | null {
  const m = /^mindmap:\/\/([a-z0-9-]{6,64})(?:\/([a-z0-9-]{6,64}))?\/?$/.exec(ref.trim())
  if (m === null) return null
  return m[2] !== undefined ? { docId: m[1]!, nodeId: m[2] } : { docId: m[1]! }
}
