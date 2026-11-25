/**
 * Client helpers for AI change tracking: what to show for a pending AI mark,
 * which rows sit inside an AI-proposed deletion, and the node-menu entries to
 * review a change. Review edits are plain document edits, so they go through
 * DocumentState.apply and are undoable like any other edit.
 * @module dsh-mindmap/client/ai
 */
import type { OutlineDoc, OutlineNode } from '../shared/model.ts'
import { pendingAi, reviewAi } from '../shared/aiOps.ts'
import { plainText } from './plain.ts'
import type { MenuEntry } from './ui.tsx'

/** Pending AI state of one displayed node; 'gone' = inside a subtree marked for deletion. */
export type AiView = 'added' | 'edited' | 'deleted' | 'gone'

/** Tooltip for a node with a pending AI mark (null when there is none). */
export function aiTip(node: OutlineNode): string | null {
  const m = node.ai
  if (m === undefined) return null
  if (m.kind === 'added') return 'AI 新增 · 待审阅'
  if (m.kind === 'deleted') return 'AI 建议删除（含子节点）· 待审阅'
  const parts = ['AI 修改 · 待审阅']
  if (m.prevText !== undefined) parts.push('原文：' + (m.prevText.length > 0 ? plainText(m.prevText) : '（空）'))
  if (m.prevNote !== undefined) parts.push('原备注：' + (m.prevNote.length > 0 ? plainText(m.prevNote) : '（无）'))
  if (m.prevChecked !== undefined) parts.push('原待办状态：' + (m.prevChecked === null ? '非待办' : m.prevChecked ? '已完成' : '未完成'))
  return parts.join('\n')
}

/** AI view of every node below `rootId` that has one (own mark, or inside a deletion). */
export function aiViews(doc: OutlineDoc, rootId: string = doc.rootId): Map<string, AiView> {
  const out = new Map<string, AiView>()
  // The zoom root may itself sit inside a deletion further up.
  let inherited = false
  const parents = new Map<string, string>()
  for (const n of Object.values(doc.nodes)) for (const c of n.children) parents.set(c, n.id)
  for (let cur = parents.get(rootId); cur !== undefined; cur = parents.get(cur)) {
    if (doc.nodes[cur]?.ai?.kind === 'deleted') { inherited = true; break }
  }
  const stack: Array<{ id: string; gone: boolean }> = [{ id: rootId, gone: inherited }]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const { id, gone } = stack.pop()!
    const n = doc.nodes[id]
    if (n === undefined || seen.has(id)) continue
    seen.add(id)
    const own = n.ai?.kind
    const view: AiView | undefined = own === 'deleted' ? 'deleted' : gone ? 'gone' : own
    if (view !== undefined) out.set(id, view)
    const kidsGone = gone || own === 'deleted'
    for (const c of n.children) stack.push({ id: c, gone: kidsGone })
  }
  return out
}

/** Ids with a pending mark in the subtree of `id` (itself included). */
export function pendingIn(doc: OutlineDoc, id: string): string[] {
  const out: string[] = []
  const stack = [id]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const cur = stack.pop()!
    const n = doc.nodes[cur]
    if (n === undefined || seen.has(cur)) continue
    seen.add(cur)
    if (n.ai !== undefined) out.push(cur)
    for (const c of n.children) stack.push(c)
  }
  return out
}

/** Number of pending AI changes in the document. */
export function pendingCount(doc: OutlineDoc): number {
  return pendingAi(doc).length
}

/**
 * Review entries for a node menu (empty when nothing in its subtree is
 * pending). `apply` receives the reviewed document and a toast message.
 */
export function reviewMenu(doc: OutlineDoc, id: string, apply: (next: OutlineDoc, message: string) => void): MenuEntry[] {
  const own = doc.nodes[id]?.ai !== undefined
  const all = pendingIn(doc, id)
  if (all.length === 0) return []
  const run = (ids: string[], decision: 'accept' | 'reject'): void => {
    const next = reviewAi(doc, ids, decision)
    if (next !== doc) apply(next, (decision === 'accept' ? '已接受 ' : '已拒绝 ') + ids.length + ' 处 AI 修改，可按 Ctrl+Z 撤销')
  }
  const items: MenuEntry[] = [{ kind: 'label', label: 'AI 修改' }]
  if (own) {
    items.push({ label: '接受此处 AI 修改', onSelect: () => run([id], 'accept') })
    items.push({ label: '拒绝此处 AI 修改', onSelect: () => run([id], 'reject') })
  }
  if (all.length > (own ? 1 : 0)) {
    items.push({ label: '接受子树中全部 AI 修改（' + all.length + '）', onSelect: () => run(all, 'accept') })
    items.push({ label: '拒绝子树中全部 AI 修改（' + all.length + '）', onSelect: () => run(all, 'reject') })
  }
  return items
}
