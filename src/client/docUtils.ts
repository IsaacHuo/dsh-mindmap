/**
 * Pure, React-free helpers shared by the sidebar and the app shell (unit-tested).
 * @module dsh-mindmap/client/docUtils
 */
import { flatten, type DocMeta, type Folder, type OutlineDoc } from '../shared/model.ts'

export type SortKey = 'updated' | 'title' | 'created'

/** Sorted copy of the document list. */
export function sortDocs(docs: readonly DocMeta[], key: SortKey): DocMeta[] {
  const out = [...docs]
  if (key === 'title') out.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN') || b.updatedAt - a.updatedAt)
  else if (key === 'created') out.sort((a, b) => b.createdAt - a.createdAt)
  else out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/** The folder and every folder nested below it. */
export function folderSubtree(folders: readonly Folder[], id: string): Set<string> {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const f of folders) if (f.parentId != null && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true }
  }
  return out
}

/** Node / character / to-do counts for the visible (sub)tree. */
export function countTree(doc: OutlineDoc, rootId: string): { nodes: number; chars: number; todo: number; done: number } {
  let nodes = 0
  let chars = 0
  let todo = 0
  let done = 0
  for (const r of flatten(doc, rootId, false)) {
    const n = doc.nodes[r.id]!
    nodes++
    chars += n.text.replace(/\s/g, '').length + (n.note ?? '').replace(/\s/g, '').length
    if (typeof n.checked === 'boolean') { todo++; if (n.checked) done++ }
  }
  return { nodes, chars, todo, done }
}
