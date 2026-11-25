/**
 * Host-side persistence: a library index plus one JSON file per document under
 * the data directory, written atomically (temp → fsync → rename) through one
 * serial queue. Every document is invariant-checked before it is written and
 * after it is read; unreadable files are quarantined (renamed), never
 * overwritten. Daily automatic backups plus manual backup/restore.
 *
 * Layout: <dir>/library.json, <dir>/docs/<id>.json, <dir>/backups/*.json
 * @module dsh-mindmap/host/storage
 */
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createDoc, ID_RE, itemsDepth, MAX_IMPORT_DEPTH, newId, normalizeTitle, validateDoc, type DocMeta, type Folder, type Library, type OutlineDoc, type TreeItem } from '../shared/model.ts'
import { indexDoc, searchIndex, type DocIndex, type SearchHit } from '../shared/search.ts'
import type { ApiErrorCode, BackupFile, BackupInfo, BackupKind, QuarantinedFile } from '../shared/api.ts'

/** Backups kept on disk per kind (oldest of that kind pruned first). */
export const BACKUP_KEEP: Readonly<Record<BackupKind, number>> = { daily: 14, manual: 10, 'pre-restore': 5, purge: 5 }

/** Accepted backup file names. */
export const BACKUP_RE = /^mindmap-\d{8}(?:-\d{6})?(?:-(?:pre-restore|purge))?\.json$/

/** Trashed documents older than this are purged automatically at startup. */
export const TRASH_RETENTION_MS = 30 * 24 * 3600 * 1000

/** Whole documents kept in memory (least recently used evicted). */
export const DOC_CACHE_LIMIT = 50

/** Who caused a document change. */
export type ChangeSource = 'user' | 'ai'

/** A saved change, pushed to listeners (the /events stream). */
export type ChangeEvent = { kind: 'doc'; docId: string; revision: number; source: ChangeSource } | { kind: 'library' }

/** Purge backups closer together than this are coalesced into one. */
const PURGE_BACKUP_DEDUPE_MS = 60 * 1000

/** Kind of a backup from its file name. */
export function backupKind(name: string): BackupKind {
  if (name.endsWith('-pre-restore.json')) return 'pre-restore'
  if (name.endsWith('-purge.json')) return 'purge'
  return /^mindmap-\d{8}\.json$/.test(name) ? 'daily' : 'manual'
}

/** A domain error mapped to an HTTP status by the routes. */
export class StorageError extends Error {
  readonly code: ApiErrorCode
  readonly current?: OutlineDoc
  constructor(code: ApiErrorCode, message: string, current?: OutlineDoc) {
    super(message)
    this.code = code
    if (current !== undefined) this.current = current
  }
}

function stamp(ms: number, withTime: boolean): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  return withTime ? `${day}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` : day
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Atomic file write; retries transient Windows sharing violations on rename. */
export async function atomicWrite(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.${Math.random().toString(36).slice(2)}.tmp`)
  const fh = await open(temp, 'w')
  try {
    await fh.writeFile(contents, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 6 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await rm(temp, { force: true }).catch(() => {})
        throw error
      }
      await sleep(40 * (attempt + 1))
    }
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** Rename with retries for transient Windows sharing violations. */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      await sleep(50 * (attempt + 1))
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

function sanitizeMeta(raw: unknown): DocMeta | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return null
  const meta: DocMeta = {
    id: m.id,
    title: normalizeTitle(m.title),
    folderId: typeof m.folderId === 'string' ? m.folderId : null,
    favorite: m.favorite === true,
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
    updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : 0,
  }
  if (typeof m.trashedAt === 'number') meta.trashedAt = m.trashedAt
  return meta
}

/** True when making 'parentId' the parent of folder 'id' would create a cycle. */
function wouldCycle(folders: readonly Folder[], id: string, parentId: string | null): boolean {
  const byId = new Map(folders.map(f => [f.id, f]))
  let cur = parentId
  for (let guard = 0; cur !== null && guard <= folders.length; guard++) {
    if (cur === id) return true
    cur = byId.get(cur)?.parentId ?? null
  }
  return cur !== null
}

function sanitizeLibrary(raw: unknown): Library | null {
  if (typeof raw !== 'object' || raw === null) return null
  const l = raw as Record<string, unknown>
  if (!Array.isArray(l.docs) || !Array.isArray(l.folders)) return null
  const folders: Folder[] = []
  const seenFolders = new Set<string>()
  for (const f of l.folders) {
    if (typeof f !== 'object' || f === null) continue
    const r = f as Record<string, unknown>
    if (typeof r.id !== 'string' || !ID_RE.test(r.id) || typeof r.name !== 'string' || seenFolders.has(r.id)) continue
    seenFolders.add(r.id)
    folders.push({ id: r.id, name: normalizeTitle(r.name, '新建文件夹'), createdAt: Number(r.createdAt) || 0, parentId: typeof r.parentId === 'string' ? r.parentId : null })
  }
  const ids = new Set(folders.map(f => f.id))
  // Drop dangling parents first, then break any cycle by lifting to the top level.
  for (const f of folders) if (f.parentId !== null && f.parentId !== undefined && !ids.has(f.parentId)) f.parentId = null
  for (const f of folders) if (f.parentId !== null && f.parentId !== undefined && wouldCycle(folders, f.id, f.parentId)) f.parentId = null
  const docs: DocMeta[] = []
  const seen = new Set<string>()
  for (const d of l.docs) {
    const meta = sanitizeMeta(d)
    if (meta === null || seen.has(meta.id)) continue
    if (meta.folderId !== null && !ids.has(meta.folderId)) meta.folderId = null
    seen.add(meta.id)
    docs.push(meta)
  }
  return { schema: 1, folders, docs }
}

/** The storage service. */
export class MindmapStorage {
  readonly dir: string
  private readonly now: () => number
  private library: Library = { schema: 1, folders: [], docs: [] }
  /** LRU cache of whole documents (Map keeps insertion order). */
  private readonly docs = new Map<string, OutlineDoc>()
  /** Compact text index of every readable document, for search. */
  private readonly index = new Map<string, DocIndex>()
  private queue: Promise<unknown> = Promise.resolve()
  private loading: Promise<void> | undefined
  private pendingWarnings: string[] = []
  private lastPurgeBackup: { at: number; info: BackupInfo } | null = null
  private readonly listeners = new Set<(event: ChangeEvent) => void>()
  private source: ChangeSource = 'user'

  constructor(dir: string, now: () => number = () => Date.now()) {
    this.dir = dir
    this.now = now
  }

  private get libraryFile(): string { return join(this.dir, 'library.json') }
  private get docsDir(): string { return join(this.dir, 'docs') }
  private get stagingDir(): string { return join(this.dir, 'docs.new') }
  private get retiredDir(): string { return join(this.dir, 'docs.old') }
  private get restoreMarker(): string { return join(this.dir, 'restore.pending.json') }
  private get backupsDir(): string { return join(this.dir, 'backups') }
  private docFile(id: string): string { return join(this.docsDir, `${id}.json`) }

  /** Problems found while loading that have not been reported yet. */
  get warnings(): readonly string[] { return this.pendingWarnings }

  /** Return the unreported warnings and forget them (each is reported once). */
  async takeWarnings(): Promise<string[]> {
    await this.ready()
    const out = this.pendingWarnings
    this.pendingWarnings = []
    return out
  }

  /** Serialize every mutation (and the initial load) through one queue. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.ready()).then(fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Load once; later calls share the same promise. */
  ready(): Promise<void> {
    this.loading ??= this.load()
    return this.loading
  }

  private async quarantine(file: string, why: string): Promise<void> {
    const target = file.replace(/\.json$/, `.corrupt-${stamp(this.now(), true)}.json`)
    await rename(file, target).catch(() => {})
    this.pendingWarnings.push(`${why}：已隔离为 ${target}`)
    console.warn(`[dsh-mindmap] ${why}; quarantined as ${target}`)
  }

  /**
   * Finish or roll back a restore interrupted by a crash. The marker holds the
   * library to install; docs.new present means the directory swap never
   * completed, so the old documents are put back.
   */
  private async recoverRestore(): Promise<void> {
    const marker = await readFile(this.restoreMarker, 'utf8').catch(() => null)
    if (marker === null) {
      await rm(this.stagingDir, { recursive: true, force: true })
      await rm(this.retiredDir, { recursive: true, force: true })
      return
    }
    if (await exists(this.stagingDir)) {
      if (!(await exists(this.docsDir)) && (await exists(this.retiredDir))) await renameRetry(this.retiredDir, this.docsDir)
      await rm(this.stagingDir, { recursive: true, force: true })
      this.pendingWarnings.push('上次恢复备份未完成，已回滚到恢复前的状态')
    } else {
      await atomicWrite(this.libraryFile, marker)
      await rm(this.retiredDir, { recursive: true, force: true })
      this.pendingWarnings.push('上次恢复备份在中途中断，已完成恢复')
    }
    await rm(this.restoreMarker, { force: true })
  }

  private async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await this.recoverRestore()
    await mkdir(this.docsDir, { recursive: true })
    await mkdir(this.backupsDir, { recursive: true })
    let library: Library | null = null
    try {
      library = sanitizeLibrary(JSON.parse(await readFile(this.libraryFile, 'utf8')))
      if (library === null) await this.quarantine(this.libraryFile, 'library.json 结构无效')
    } catch (error) {
      if (!isEnoent(error)) await this.quarantine(this.libraryFile, 'library.json 无法解析')
    }
    // Reconcile with the document files: a doc file without a library row
    // (crash between the two writes, or a lost library) is re-adopted.
    const files = (await readdir(this.docsDir)).filter(f => /^[a-z0-9-]{6,64}\.json$/.test(f))
    const lib: Library = library ?? { schema: 1, folders: [], docs: [] }
    const known = new Set(lib.docs.map(d => d.id))
    let adopted = false
    for (const file of files) {
      const id = file.slice(0, -5)
      if (known.has(id)) continue
      const doc = await this.readDocFile(id).catch(() => null)
      if (doc === null) continue
      lib.docs.push({ id, title: doc.title, folderId: null, favorite: false, createdAt: doc.createdAt, updatedAt: doc.updatedAt })
      adopted = true
    }
    const present = new Set(files.map(f => f.slice(0, -5)))
    const before = lib.docs.length
    lib.docs = lib.docs.filter(d => present.has(d.id))
    this.library = lib
    if (adopted || library === null || lib.docs.length !== before) {
      if (lib.docs.length > 0 || library !== null) await this.writeLibrary()
    }
    // Trash retention: purge long-trashed documents (after one purge backup).
    const cutoff = this.now() - TRASH_RETENTION_MS
    const expired = lib.docs.filter(d => d.trashedAt !== undefined && d.trashedAt < cutoff).map(d => d.id)
    if (expired.length > 0) {
      try {
        await this.purgeIds(expired)
      } catch (error) {
        console.warn('[dsh-mindmap] trash auto-purge failed:', error)
      }
    }
  }

  private async readDocFile(id: string): Promise<OutlineDoc> {
    const file = this.docFile(id)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (isEnoent(error)) throw new StorageError('not_found', '文档不存在')
      await this.quarantine(file, `文档 ${id} 无法解析`)
      throw new StorageError('internal', '文档文件已损坏并已隔离')
    }
    const problem = validateDoc(parsed)
    if (problem !== null || (parsed as OutlineDoc).id !== id) {
      await this.quarantine(file, `文档 ${id} 结构无效（${problem ?? 'id 不匹配'}）`)
      throw new StorageError('internal', '文档文件结构无效并已隔离')
    }
    return parsed as OutlineDoc
  }

  private async writeLibrary(): Promise<void> {
    await atomicWrite(this.libraryFile, JSON.stringify(this.library, null, 1))
    this.emit({ kind: 'library' })
  }

  /** Subscribe to saved changes (documents and the library); returns an unsubscriber. */
  onChange(fn: (event: ChangeEvent) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private emit(event: ChangeEvent): void {
    for (const fn of this.listeners) {
      try { fn(event) } catch (error) { console.warn('[dsh-mindmap] change listener failed:', error) }
    }
  }

  /** Absolute path of a document's JSON file (read-only use: edits must go through this service). */
  docPath(id: string): string {
    if (!ID_RE.test(id)) throw new StorageError('invalid_input', '无效的文档 id')
    return this.docFile(id)
  }

  /** Absolute documents directory. */
  get documentsDir(): string { return this.docsDir }

  /**
   * Read-modify-write one document inside the serial queue (used by the agent
   * tool). `fn` returns the next document (or the same object for a no-op)
   * plus a result; the revision is bumped and a change event is emitted.
   * Trashed documents are refused.
   */
  mutateDoc<T>(id: string, fn: (doc: OutlineDoc) => { doc: OutlineDoc; result: T }, source: ChangeSource = 'ai'): Promise<{ doc: OutlineDoc; result: T; changed: boolean }> {
    return this.serial(async () => {
      const meta = this.meta(id)
      if (meta.trashedAt !== undefined) throw new StorageError('invalid_input', '文档在回收站中，不能修改')
      const current = await this.loadDoc(id)
      const out = fn(structuredClone(current))
      if (out.doc === current || JSON.stringify(out.doc.nodes) === JSON.stringify(current.nodes) && out.doc.title === current.title) {
        return { doc: current, result: out.result, changed: false }
      }
      if (out.doc.id !== id) throw new StorageError('invalid_input', '文档 id 不匹配')
      await this.dailyBackup()
      const now = this.now()
      const next: OutlineDoc = { ...out.doc, title: normalizeTitle(out.doc.title), revision: current.revision + 1, createdAt: current.createdAt, updatedAt: now }
      this.source = source
      try {
        await this.writeDoc(next)
      } finally {
        this.source = 'user'
      }
      meta.title = next.title
      meta.updatedAt = now
      await this.writeLibrary()
      return { doc: next, result: out.result, changed: true }
    })
  }

  private remember(doc: OutlineDoc): void {
    this.docs.delete(doc.id)
    this.docs.set(doc.id, doc)
    while (this.docs.size > DOC_CACHE_LIMIT) this.docs.delete(this.docs.keys().next().value!)
    this.index.set(doc.id, indexDoc(doc))
  }

  private async writeDoc(doc: OutlineDoc): Promise<void> {
    const problem = validateDoc(doc)
    if (problem !== null) throw new StorageError('invalid_input', `文档结构无效：${problem}`)
    await atomicWrite(this.docFile(doc.id), JSON.stringify(doc))
    this.remember(doc)
    this.emit({ kind: 'doc', docId: doc.id, revision: doc.revision, source: this.source })
  }

  private meta(id: string): DocMeta {
    if (!ID_RE.test(id)) throw new StorageError('invalid_input', '无效的文档 id')
    const meta = this.library.docs.find(d => d.id === id)
    if (meta === undefined) throw new StorageError('not_found', '文档不存在')
    return meta
  }

  private async loadDoc(id: string): Promise<OutlineDoc> {
    this.meta(id)
    const cached = this.docs.get(id)
    if (cached !== undefined) {
      this.docs.delete(id)
      this.docs.set(id, cached)
      return cached
    }
    const doc = await this.readDocFile(id)
    this.remember(doc)
    return doc
  }

  private checkFolder(folderId: unknown): string | null {
    if (folderId === null || folderId === undefined) return null
    if (typeof folderId !== 'string' || !this.library.folders.some(f => f.id === folderId)) throw new StorageError('invalid_input', '文件夹不存在')
    return folderId
  }

  /** A copy of the library index. */
  async getLibrary(): Promise<Library> {
    await this.ready()
    return structuredClone(this.library)
  }

  async getDoc(id: string): Promise<OutlineDoc> {
    await this.ready()
    return this.serial(() => this.loadDoc(id))
  }

  createDoc(input: { title?: unknown; folderId?: unknown; items?: TreeItem[] }): Promise<{ meta: DocMeta; doc: OutlineDoc }> {
    return this.serial(async () => {
      const folderId = this.checkFolder(input.folderId)
      const items = input.items ?? []
      if (itemsDepth(items) > MAX_IMPORT_DEPTH) throw new StorageError('invalid_input', `层级超过 ${MAX_IMPORT_DEPTH} 级，无法导入`)
      await this.dailyBackup()
      const now = this.now()
      const doc = createDoc(normalizeTitle(input.title), now, items)
      await this.writeDoc(doc)
      const meta: DocMeta = { id: doc.id, title: doc.title, folderId, favorite: false, createdAt: now, updatedAt: now }
      this.library.docs.push(meta)
      await this.writeLibrary()
      return { meta: { ...meta }, doc }
    })
  }

  /** Optimistic-concurrency save: `baseRevision` must match the stored revision. */
  saveDoc(id: string, incoming: unknown, baseRevision: unknown): Promise<OutlineDoc> {
    return this.serial(async () => {
      const meta = this.meta(id)
      const current = await this.loadDoc(id)
      if (typeof baseRevision !== 'number' || baseRevision !== current.revision) {
        throw new StorageError('conflict', '文档已在其他窗口被修改', current)
      }
      const problem = validateDoc(incoming)
      if (problem !== null) throw new StorageError('invalid_input', `文档结构无效：${problem}`)
      const doc = incoming as OutlineDoc
      if (doc.id !== id) throw new StorageError('invalid_input', '文档 id 不匹配')
      await this.dailyBackup()
      const now = this.now()
      const next: OutlineDoc = { ...doc, title: normalizeTitle(doc.title), revision: current.revision + 1, createdAt: current.createdAt, updatedAt: now }
      await this.writeDoc(next)
      meta.title = next.title
      meta.updatedAt = now
      await this.writeLibrary()
      return next
    })
  }

  /** Rename / move to folder / (un)favorite. A rename also rewrites the document title. */
  patchMeta(id: string, body: { title?: unknown; folderId?: unknown; favorite?: unknown }): Promise<{ meta: DocMeta; doc?: OutlineDoc }> {
    return this.serial(async () => {
      const meta = this.meta(id)
      let doc: OutlineDoc | undefined
      if (body.folderId !== undefined) meta.folderId = this.checkFolder(body.folderId)
      if (body.favorite !== undefined) meta.favorite = body.favorite === true
      if (body.title !== undefined) {
        const title = normalizeTitle(body.title)
        const current = await this.loadDoc(id)
        if (current.title !== title) {
          await this.dailyBackup()
          const now = this.now()
          doc = { ...current, title, revision: current.revision + 1, updatedAt: now }
          await this.writeDoc(doc)
          meta.updatedAt = now
        }
        meta.title = title
      }
      await this.writeLibrary()
      return doc === undefined ? { meta: { ...meta } } : { meta: { ...meta }, doc }
    })
  }

  /** Soft delete into the trash. */
  trashDoc(id: string): Promise<DocMeta> {
    return this.serial(async () => {
      const meta = this.meta(id)
      meta.trashedAt = this.now()
      await this.writeLibrary()
      return { ...meta }
    })
  }

  restoreDoc(id: string): Promise<DocMeta> {
    return this.serial(async () => {
      const meta = this.meta(id)
      delete meta.trashedAt
      await this.writeLibrary()
      return { ...meta }
    })
  }

  /** Remove documents for good, after one (coalesced) purge backup. Caller holds the queue. */
  private async purgeIds(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    const last = this.lastPurgeBackup
    if (last === null || this.now() - last.at > PURGE_BACKUP_DEDUPE_MS) {
      this.lastPurgeBackup = { at: this.now(), info: await this.backupInternal('purge') }
    }
    const gone = new Set(ids)
    this.library.docs = this.library.docs.filter(d => !gone.has(d.id))
    await this.writeLibrary()
    for (const id of gone) {
      this.docs.delete(id)
      this.index.delete(id)
      await rm(this.docFile(id), { force: true })
    }
  }

  /** Permanent delete; only trashed documents. */
  purgeDoc(id: string): Promise<void> {
    return this.serial(async () => {
      const meta = this.meta(id)
      if (meta.trashedAt === undefined) throw new StorageError('invalid_input', '只能永久删除回收站中的文档')
      await this.purgeIds([id])
    })
  }

  /** Permanently delete everything in the trash; returns how many documents went. */
  emptyTrash(): Promise<{ purged: number }> {
    return this.serial(async () => {
      const ids = this.library.docs.filter(d => d.trashedAt !== undefined).map(d => d.id)
      await this.purgeIds(ids)
      return { purged: ids.length }
    })
  }

  createFolder(name: unknown, parentId: unknown = null): Promise<Folder> {
    return this.serial(async () => {
      const parent = this.checkFolder(parentId)
      const folder: Folder = { id: newId(), name: normalizeTitle(name, '新建文件夹'), createdAt: this.now(), parentId: parent }
      this.library.folders.push(folder)
      await this.writeLibrary()
      return { ...folder }
    })
  }

  renameFolder(id: string, name: unknown): Promise<Folder> {
    return this.serial(async () => {
      const folder = this.library.folders.find(f => f.id === id)
      if (folder === undefined) throw new StorageError('not_found', '文件夹不存在')
      folder.name = normalizeTitle(name, folder.name)
      await this.writeLibrary()
      return { ...folder }
    })
  }

  /** Move a folder under another folder (null = top level); cycles are refused. */
  moveFolder(id: string, parentId: unknown): Promise<Folder> {
    return this.serial(async () => {
      const folder = this.library.folders.find(f => f.id === id)
      if (folder === undefined) throw new StorageError('not_found', '文件夹不存在')
      const parent = this.checkFolder(parentId)
      if (parent !== null && wouldCycle(this.library.folders, id, parent)) throw new StorageError('invalid_input', '不能把文件夹移到它自己的子文件夹里')
      folder.parentId = parent
      await this.writeLibrary()
      return { ...folder }
    })
  }

  /** Delete a folder; its documents and sub-folders move up one level (never deleted). */
  deleteFolder(id: string): Promise<void> {
    return this.serial(async () => {
      const folder = this.library.folders.find(f => f.id === id)
      if (folder === undefined) throw new StorageError('not_found', '文件夹不存在')
      const up = folder.parentId ?? null
      this.library.folders = this.library.folders.filter(f => f.id !== id)
      for (const f of this.library.folders) if (f.parentId === id) f.parentId = up
      for (const d of this.library.docs) if (d.folderId === id) d.folderId = up
      await this.writeLibrary()
    })
  }

  /** Title + node text + note search over non-trashed documents (uses the text index). */
  search(query: string, limit = 100): Promise<SearchHit[]> {
    return this.serial(async () => {
      const hits: SearchHit[] = []
      if (query.trim().length === 0) return hits
      for (const meta of this.library.docs) {
        if (meta.trashedAt !== undefined) continue
        if (hits.length >= limit) break
        let idx = this.index.get(meta.id)
        if (idx === undefined) {
          try {
            idx = indexDoc(await this.readDocFile(meta.id))
            this.index.set(meta.id, idx)
          } catch { continue /* unreadable docs are skipped (already quarantined) */ }
        }
        hits.push(...searchIndex(idx, meta.title, query, limit - hits.length))
      }
      return hits
    })
  }

  /** Quarantined (corrupt) files, newest first; paths relative to the data directory. */
  async listQuarantine(): Promise<QuarantinedFile[]> {
    await this.ready()
    const out: QuarantinedFile[] = []
    for (const [sub, dir] of [['', this.dir], ['docs/', this.docsDir]] as const) {
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!/\.corrupt-\d{8}-\d{6}\.json$/.test(name)) continue
        const s = await stat(join(dir, name)).catch(() => null)
        if (s !== null && s.isFile()) out.push({ name: sub + name, size: s.size, createdAt: s.mtimeMs })
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  // -------------------------------------------------------------- backups

  private async snapshot(): Promise<BackupFile> {
    const docs: OutlineDoc[] = []
    for (const meta of this.library.docs) {
      try { docs.push(this.docs.get(meta.id) ?? await this.readDocFile(meta.id)) } catch { /* skip unreadable */ }
    }
    return { schema: 1, kind: 'dsh-mindmap-backup', createdAt: this.now(), library: structuredClone(this.library), docs }
  }

  private async backupInternal(kind: BackupKind): Promise<BackupInfo> {
    const now = this.now()
    const suffix = kind === 'pre-restore' ? '-pre-restore' : kind === 'purge' ? '-purge' : ''
    let name = kind === 'daily' ? `mindmap-${stamp(now, false)}.json` : `mindmap-${stamp(now, true)}${suffix}.json`
    // Two backups of the same kind within one second must not overwrite each other.
    for (let bump = 1; kind !== 'daily' && await exists(join(this.backupsDir, name)) && bump < 60; bump++) {
      name = `mindmap-${stamp(now + bump * 1000, true)}${suffix}.json`
    }
    const contents = JSON.stringify(await this.snapshot())
    await atomicWrite(join(this.backupsDir, name), contents)
    await this.prune()
    return { name, size: Buffer.byteLength(contents), createdAt: now, kind }
  }

  /**
   * The first write of a local day snapshots the library as it was BEFORE that
   * write, so the day's starting state is always recoverable. Empty libraries
   * are not backed up.
   */
  private async dailyBackup(): Promise<void> {
    if (this.library.docs.length === 0) return
    const name = `mindmap-${stamp(this.now(), false)}.json`
    if (await exists(join(this.backupsDir, name))) return
    await this.backupInternal('daily').catch(e => console.warn('[dsh-mindmap] daily backup failed:', e))
  }

  /** Keep the newest BACKUP_KEEP[kind] files of each kind. */
  private async prune(): Promise<void> {
    const seen: Record<BackupKind, number> = { daily: 0, manual: 0, 'pre-restore': 0, purge: 0 }
    for (const b of await this.listBackupsRaw()) {
      const kind = b.kind ?? 'manual'
      seen[kind]++
      if (seen[kind] > BACKUP_KEEP[kind]) await rm(join(this.backupsDir, b.name), { force: true })
    }
  }

  private async listBackupsRaw(): Promise<BackupInfo[]> {
    const out: BackupInfo[] = []
    for (const name of await readdir(this.backupsDir).catch(() => [] as string[])) {
      if (!BACKUP_RE.test(name)) continue
      const s = await stat(join(this.backupsDir, name)).catch(() => null)
      if (s !== null) out.push({ name, size: s.size, createdAt: s.mtimeMs, kind: backupKind(name) })
    }
    return out.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1))
  }

  async listBackups(): Promise<BackupInfo[]> {
    await this.ready()
    return this.listBackupsRaw()
  }

  backupNow(): Promise<BackupInfo> {
    return this.serial(() => this.backupInternal('manual'))
  }

  async readBackup(name: string): Promise<string> {
    await this.ready()
    if (!BACKUP_RE.test(name)) throw new StorageError('invalid_input', '无效的备份文件名')
    try {
      return await readFile(join(this.backupsDir, name), 'utf8')
    } catch (error) {
      if (isEnoent(error)) throw new StorageError('not_found', '备份不存在')
      throw error
    }
  }

  /**
   * Replace everything with a backup. The current state is first saved as a
   * "-pre-restore" backup, so a restore is itself reversible. The new documents
   * are staged in docs.new/ and swapped in with directory renames; a crash at
   * any point is finished or rolled back on the next start (recoverRestore).
   */
  restore(source: { name: string } | { data: unknown }): Promise<{ docs: number; preRestore: string }> {
    return this.serial(async () => {
      let raw: unknown
      if ('name' in source) {
        const text = await this.readBackup(source.name)
        try { raw = JSON.parse(text) } catch { throw new StorageError('invalid_input', '备份文件不是有效 JSON') }
      } else raw = source.data
      const file = raw as BackupFile
      if (typeof file !== 'object' || file === null || file.kind !== 'dsh-mindmap-backup' || !Array.isArray(file.docs)) {
        throw new StorageError('invalid_input', '不是有效的思维导图备份文件')
      }
      const library = sanitizeLibrary(file.library)
      if (library === null) throw new StorageError('invalid_input', '备份中的文档库无效')
      for (const doc of file.docs) {
        const problem = validateDoc(doc)
        if (problem !== null) throw new StorageError('invalid_input', `备份中的文档无效：${problem}`)
      }
      const byId = new Map(file.docs.map(d => [d.id, d]))
      library.docs = library.docs.filter(d => byId.has(d.id))
      const pre = await this.backupInternal('pre-restore')

      await rm(this.stagingDir, { recursive: true, force: true })
      await rm(this.retiredDir, { recursive: true, force: true })
      await mkdir(this.stagingDir, { recursive: true })
      for (const meta of library.docs) await atomicWrite(join(this.stagingDir, `${meta.id}.json`), JSON.stringify(byId.get(meta.id)!))
      const libText = JSON.stringify(library, null, 1)
      await atomicWrite(this.restoreMarker, libText)
      await renameRetry(this.docsDir, this.retiredDir)
      await renameRetry(this.stagingDir, this.docsDir)
      await atomicWrite(this.libraryFile, libText)
      await rm(this.restoreMarker, { force: true })
      await rm(this.retiredDir, { recursive: true, force: true })

      this.docs.clear()
      this.index.clear()
      this.library = library
      return { docs: library.docs.length, preRestore: pre.name }
    })
  }
}
