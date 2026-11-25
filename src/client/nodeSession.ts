/**
 * Text handed to the AI from a node: the first prompt of a node-bound session
 * and the quote inserted into a conversation. Pure functions (tested).
 * @module dsh-mindmap/client/nodeSession
 */
import { ancestors, type OutlineDoc } from '../shared/model.ts'
import { toMarkdown } from '../shared/markdown.ts'
import { nodeRef } from '../shared/aiOps.ts'
import { plainText } from './plain.ts'

/** Subtree Markdown longer than this is cut (the AI can read the rest with the tool). */
export const PROMPT_SUBTREE_LIMIT = 8000

/** First line of a node as plain text, for titles and paths. */
export function nodeLabel(doc: OutlineDoc, id: string): string {
  if (id === doc.rootId) return doc.title
  const first = plainText(doc.nodes[id]?.text ?? '').split('\n')[0]!.trim()
  return first.length > 0 ? first : '（空节点）'
}

/** Path from the document title down to the node, joined with ' › '. */
export function nodePath(doc: OutlineDoc, id: string): string {
  const parts = [doc.title]
  for (const a of ancestors(doc, id)) if (a !== doc.rootId) parts.push(nodeLabel(doc, a))
  if (id !== doc.rootId) parts.push(nodeLabel(doc, id))
  return parts.join(' › ')
}

/** Markdown of the node's subtree, cut at `limit` characters. */
export function subtreeMarkdown(doc: OutlineDoc, id: string, limit = PROMPT_SUBTREE_LIMIT): { text: string; cut: boolean } {
  const md = toMarkdown(doc, id, nodeLabel(doc, id))
  if (md.length <= limit) return { text: md, cut: false }
  const at = md.lastIndexOf('\n', limit)
  return { text: md.slice(0, at > limit / 2 ? at : limit), cut: true }
}

/** First prompt of a session bound to node `id`. */
export function nodeSessionPrompt(doc: OutlineDoc, id: string): string {
  const ref = nodeRef(doc.id, id === doc.rootId ? undefined : id)
  const sub = subtreeMarkdown(doc, id)
  return [
    `我们围绕思维导图「${doc.title}」中的这个节点展开讨论：`,
    '',
    `- 位置：${nodePath(doc, id)}`,
    `- 引用：${ref}`,
    '',
    '节点及其子节点（Markdown）：',
    '',
    '```markdown',
    sub.text.trimEnd(),
    '```',
    ...(sub.cut ? ['', `（内容较长，已截断；完整内容请用 mindmap 工具 read ${ref}）`] : []),
    '',
    '需要修改导图时请用 mindmap 工具的 apply：你的修改会留痕（新增 / 修改保留原文 / 删除只划线），由我审阅接受或拒绝，不要直接改文件。',
    '',
    '我的问题：',
  ].join('\n')
}

/** Quote inserted into a conversation for node `id`. */
export function nodeQuote(doc: OutlineDoc, id: string): { text: string; summary: string } {
  const ref = nodeRef(doc.id, id === doc.rootId ? undefined : id)
  const sub = subtreeMarkdown(doc, id, 4000)
  const text = `${nodePath(doc, id)}（${ref}）\n\n${sub.text.trimEnd()}${sub.cut ? '\n…（已截断，可用 mindmap 工具读取全文）' : ''}`
  return { text, summary: '思维导图：' + nodeLabel(doc, id) }
}
