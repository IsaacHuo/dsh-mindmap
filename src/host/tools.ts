/**
 * The `mindmap` agent tool: lets the model list, read, search and edit
 * mind-map documents. Every edit goes through applyAiOps, so nothing the
 * model does is destructive: additions are marked, rewrites keep the
 * original, deletions are only struck through, and only the user can accept
 * or reject them in the UI. The tool has no file-system access.
 * @module dsh-mindmap/host/tools
 */
import { applyAiOps, AiOpError, nodeRef, parseRef } from '../shared/aiOps.ts'
import { ancestors, type OutlineDoc } from '../shared/model.ts'
import { StorageError, type MindmapStorage } from './storage.ts'

export const TOOL_NAME = 'mindmap'

export const TOOL_DESCRIPTION = [
  'Read and edit the user\'s mind maps / outlines (the 思维导图 plugin).',
  'Actions: list (documents), read (a document or a subtree as an indented outline with node ids), search (text across documents), apply (edit a document).',
  'Documents and nodes may be addressed by docId/nodeId or by a reference "mindmap://<docId>/<nodeId>".',
  'apply takes ops: {op:"add", parentId, index?, text, note?, checked?, children?:[{text, note?, children?}]}, {op:"edit", nodeId, text?, note?, checked?: true|false|null}, {op:"delete", nodeId}.',
  'Edits are tracked for the user\'s review: added nodes are highlighted, edited nodes keep their original text, and delete only strikes a node through (it stays until the user accepts). You cannot accept or reject changes, and you cannot move nodes.',
  'Read before editing; use the node ids shown in brackets. Ops in one call are applied atomically, at most 200 per call.',
].join(' ')

/** JSON-Schema parameters of the tool. */
export const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'read', 'search', 'apply'], description: 'What to do.' },
    docId: { type: 'string', description: 'Document id, or a mindmap:// reference (read, apply).' },
    nodeId: { type: 'string', description: 'read: only this subtree.' },
    depth: { type: 'number', description: 'read: max depth below the start node (default 8).' },
    query: { type: 'string', description: 'search: text to find.' },
    ops: { type: 'array', description: 'apply: list of add / edit / delete operations.', items: { type: 'object' } },
  },
  required: ['action'],
  additionalProperties: false,
} as const

/** Max nodes printed by one read. */
export const READ_NODE_LIMIT = 1500

export interface ToolContext { sessionId?: string; now?: () => number }

export interface ToolResult { ok: boolean; text: string; data?: unknown }

const MARK: Record<string, string> = { added: ' ⟨AI 新增·待审⟩', edited: ' ⟨AI 修改·待审⟩', deleted: ' ⟨AI 删除·待审⟩' }

function oneLine(s: string): string {
  return s.replace(/\r?\n/g, ' ⏎ ')
}

/** Indented outline of a document (or a subtree) with node ids and review marks. */
export function renderOutline(doc: OutlineDoc, startId: string = doc.rootId, maxDepth = 8): { text: string; nodes: number; truncated: boolean } {
  const lines: string[] = []
  const start = doc.nodes[startId]
  if (start === undefined) return { text: '', nodes: 0, truncated: false }
  const header = startId === doc.rootId
    ? `# ${doc.title}  (${nodeRef(doc.id)}, rootId ${doc.rootId}, revision ${doc.revision})`
    : `# ${doc.title} › ${ancestors(doc, startId).filter(a => a !== doc.rootId).map(a => oneLine(doc.nodes[a]!.text)).concat(oneLine(start.text)).join(' › ')}  (${nodeRef(doc.id, startId)}, revision ${doc.revision})`
  lines.push(header)
  let count = 0
  let truncated = false
  const stack: Array<[string, number]> = []
  const kids = startId === doc.rootId ? start.children : [startId]
  for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, 0])
  while (stack.length > 0) {
    const [id, depth] = stack.pop()!
    const n = doc.nodes[id]
    if (n === undefined) continue
    if (count >= READ_NODE_LIMIT) { truncated = true; break }
    count++
    const pad = '  '.repeat(depth)
    const box = n.checked === true ? '[x] ' : n.checked === false ? '[ ] ' : ''
    const mark = n.ai !== undefined ? MARK[n.ai.kind] + (n.ai.kind === 'edited' && n.ai.prevText !== undefined ? ` (原文: ${oneLine(n.ai.prevText)})` : '') : ''
    const bound = n.sessions !== undefined && n.sessions.length > 0 ? ` ⟨绑定会话 ${n.sessions.length}⟩` : ''
    lines.push(`${pad}- [${id}] ${box}${oneLine(n.text)}${mark}${bound}`)
    if (n.note !== undefined && n.note.length > 0) lines.push(`${pad}  note: ${oneLine(n.note)}`)
    if (n.children.length === 0) continue
    if (depth + 1 > maxDepth) { lines.push(`${pad}  … ${n.children.length} child node(s) not shown (read nodeId ${id})`); continue }
    for (let i = n.children.length - 1; i >= 0; i--) stack.push([n.children[i]!, depth + 1])
  }
  if (truncated) lines.push(`… output truncated at ${READ_NODE_LIMIT} nodes; read a subtree with nodeId`)
  return { text: lines.join('\n'), nodes: count, truncated }
}

function resolve(args: Record<string, unknown>): { docId: string; nodeId?: string } {
  const raw = typeof args.docId === 'string' ? args.docId.trim() : ''
  if (raw.length === 0) throw new AiOpError('docId is required (use action "list" to find one)')
  const ref = raw.startsWith('mindmap://') ? parseRef(raw) : { docId: raw }
  if (ref === null) throw new AiOpError('invalid mindmap:// reference')
  const nodeId = typeof args.nodeId === 'string' && args.nodeId.length > 0 ? (args.nodeId.startsWith('mindmap://') ? parseRef(args.nodeId)?.nodeId : args.nodeId) : ref.nodeId
  return nodeId !== undefined ? { docId: ref.docId, nodeId } : { docId: ref.docId }
}

/** Run one tool call. Never throws: errors come back as `{ ok: false }`. */
export async function runMindmapTool(storage: MindmapStorage, argsIn: unknown, ctx: ToolContext = {}): Promise<ToolResult> {
  const args = typeof argsIn === 'object' && argsIn !== null ? argsIn as Record<string, unknown> : {}
  try {
    switch (args.action) {
      case 'list': {
        const lib = await storage.getLibrary()
        const folders = new Map(lib.folders.map(f => [f.id, f.name]))
        const docs = lib.docs.filter(d => d.trashedAt === undefined).sort((a, b) => b.updatedAt - a.updatedAt)
        const rows = docs.map(d => `- ${d.title}  docId ${d.id}${d.folderId !== null ? `  folder ${folders.get(d.folderId) ?? '?'}` : ''}  updated ${new Date(d.updatedAt).toISOString()}`)
        return { ok: true, text: docs.length === 0 ? 'No documents.' : `${docs.length} document(s):\n${rows.join('\n')}`, data: docs.map(d => ({ id: d.id, title: d.title })) }
      }
      case 'read': {
        const { docId, nodeId } = resolve(args)
        const doc = await storage.getDoc(docId)
        if (nodeId !== undefined && doc.nodes[nodeId] === undefined) throw new AiOpError(`unknown nodeId ${nodeId}`)
        const depth = typeof args.depth === 'number' && args.depth >= 0 ? Math.min(Math.floor(args.depth), 200) : 8
        const r = renderOutline(doc, nodeId ?? doc.rootId, depth)
        return { ok: true, text: r.text, data: { docId, revision: doc.revision, nodes: r.nodes, truncated: r.truncated } }
      }
      case 'search': {
        const q = typeof args.query === 'string' ? args.query.trim().slice(0, 200) : ''
        if (q.length === 0) throw new AiOpError('query is required')
        const hits = await storage.search(q, 50)
        const rows = hits.map(h => `- ${h.title}  ${h.nodeId === null ? nodeRef(h.docId) + ' (title)' : nodeRef(h.docId, h.nodeId)}  ${h.snippet}`)
        return { ok: true, text: hits.length === 0 ? 'No matches.' : rows.join('\n'), data: hits }
      }
      case 'apply': {
        const { docId } = resolve(args)
        const ops = args.ops
        if (!Array.isArray(ops)) throw new AiOpError('ops must be an array')
        const now = (ctx.now ?? Date.now)()
        const r = await storage.mutateDoc(docId, doc => {
          const applied = applyAiOps(doc, ops, ctx.sessionId !== undefined ? { now, sessionId: ctx.sessionId } : { now })
          return { doc: applied.doc, result: applied }
        })
        const a = r.result
        const summary = r.changed
          ? `Applied to "${r.doc.title}" (revision ${r.doc.revision}): ${a.added.length} added, ${a.edited.length} edited, ${a.deleted.length} marked for deletion${a.removed.length > 0 ? `, ${a.removed.length} unreviewed AI node(s) removed` : ''}. The user reviews these changes in the mind map.`
          : 'No change (the ops left the document as it was).'
        const ids = a.added.length > 0 ? `\nNew node ids: ${a.added.join(', ')}` : ''
        return { ok: true, text: summary + ids, data: { docId, revision: r.doc.revision, added: a.added, edited: a.edited, deleted: a.deleted, removed: a.removed } }
      }
      default:
        throw new AiOpError('action must be one of list, read, search, apply')
    }
  } catch (error) {
    if (error instanceof AiOpError || error instanceof StorageError) return { ok: false, text: 'Error: ' + error.message }
    console.error('[dsh-mindmap] tool failed:', error)
    return { ok: false, text: 'Error: internal failure' }
  }
}
