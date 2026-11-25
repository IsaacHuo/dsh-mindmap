/**
 * DSH workspaces as mind-map groups (工作区). Documents stay in the plugin data
 * directory; DocMeta.workspaceId only records which workspace a document
 * belongs to. The live list comes from the DSH `workspaces` client service;
 * without it (harness, old DSH) grouping falls back to the stored names.
 * @module dsh-mindmap/client/workspaces
 */
import type { DocMeta, Folder, Library } from '../shared/model.ts'

/** One DSH workspace as the plugin sees it. */
export interface Workspace {
  id: string
  name: string
  cwd?: string
}

/** A sidebar group: a workspace, or 未归类 (id null). */
export interface WorkspaceGroup {
  id: string | null
  name: string
  docs: DocMeta[]
}

export const UNASSIGNED = '未归类'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

/** Normalise one raw workspace item from the DSH snapshot (field names probed). */
export function toWorkspace(raw: unknown): Workspace | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.archived === true || r.hidden === true) return null
  const id = str(r.workspaceId) ?? str(r.id)
  if (id === undefined) return null
  const cwd = str(r.cwd) ?? str(r.path) ?? str(r.rootPath) ?? str(r.root)
  const name = str(r.name) ?? str(r.title) ?? str(r.displayName) ?? str(r.label) ?? (cwd !== undefined ? base(cwd) : undefined) ?? id
  return cwd === undefined ? { id, name } : { id, name, cwd }
}

/** Normalise the snapshot ({items} | {byId} | array). */
export function toWorkspaces(snapshot: unknown): Workspace[] {
  const s = snapshot as { items?: unknown; byId?: unknown } | unknown[] | null | undefined
  const raw: unknown[] = Array.isArray(s) ? s
    : Array.isArray(s?.items) ? s.items
      : s !== null && typeof s === 'object' && typeof s.byId === 'object' && s.byId !== null ? Object.values(s.byId as object)
        : []
  const out: Workspace[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const w = toWorkspace(item)
    if (w !== null && !seen.has(w.id)) { seen.add(w.id); out.push(w) }
  }
  return out
}

/**
 * Group live documents by workspace. `known` = the live DSH list, or null when
 * the service is unavailable (then stored names are trusted). Every known
 * workspace gets a group (also empty ones, so it can be a drop target); 未归类
 * holds unassigned documents and those whose workspace no longer exists.
 */
export function groupByWorkspace(docs: readonly DocMeta[], known: readonly Workspace[] | null): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>()
  for (const w of known ?? []) groups.set(w.id, { id: w.id, name: w.name, docs: [] })
  const loose: DocMeta[] = []
  for (const d of docs) {
    const id = d.workspaceId
    if (typeof id !== 'string') { loose.push(d); continue }
    let g = groups.get(id)
    if (g === undefined) {
      if (known !== null) { loose.push(d); continue }
      g = { id, name: d.workspaceName ?? id, docs: [] }
      groups.set(id, g)
    }
    g.docs.push(d)
  }
  const list = [...groups.values()]
  if (known === null) list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  list.push({ id: null, name: UNASSIGNED, docs: loose })
  return list
}

/** Patch for one document's workspace assignment. */
export interface WorkspacePatch { id: string; workspaceId: string | null; workspaceName?: string }

/**
 * One-time migration of ≤0.3 folders: every document that was never assigned
 * (workspaceId undefined) goes to the workspace whose name equals its folder's
 * name (or one of its ancestors'), otherwise to 未归类. Folder data is left
 * untouched in library.json.
 */
export function migrationPatches(lib: Library, known: readonly Workspace[]): WorkspacePatch[] {
  const byName = new Map<string, Workspace>()
  for (const w of known) {
    const k = w.name.trim().toLowerCase()
    if (!byName.has(k)) byName.set(k, w)
  }
  const folders = new Map<string, Folder>(lib.folders.map(f => [f.id, f]))
  const match = (folderId: string | null): Workspace | undefined => {
    const seen = new Set<string>()
    for (let f = folderId !== null ? folders.get(folderId) : undefined; f !== undefined && !seen.has(f.id); f = f.parentId != null ? folders.get(f.parentId) : undefined) {
      seen.add(f.id)
      const w = byName.get(f.name.trim().toLowerCase())
      if (w !== undefined) return w
    }
    return undefined
  }
  const out: WorkspacePatch[] = []
  for (const d of lib.docs) {
    if (d.workspaceId !== undefined) continue
    const w = match(d.folderId)
    out.push(w === undefined ? { id: d.id, workspaceId: null } : { id: d.id, workspaceId: w.id, workspaceName: w.name })
  }
  return out
}

/** Name to show for a document's workspace. */
export function workspaceLabel(d: DocMeta | undefined, known: readonly Workspace[] | null): string {
  if (d === undefined || typeof d.workspaceId !== 'string') return UNASSIGNED
  const w = known?.find(x => x.id === d.workspaceId)
  if (w !== undefined) return w.name
  return known === null ? d.workspaceName ?? d.workspaceId : UNASSIGNED
}
