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
import { createDoc, ID_RE, newId, normalizeTitle, validateDoc, type DocMeta, type Folder, type Library, type OutlineDoc, type TreeItem } from '../shared/model.ts'
import { searchDoc, type SearchHit } from '../shared/search.ts'
import type { ApiErrorCode, BackupFile, BackupInfo } from '../shared/api.ts'

/** Backups kept on disk (oldest pruned first). */
export const MAX_BACKUPS = 30

/** Accepted backup file names. */
export const BACKUP_RE = /^mindmap-\d{8}(?:-\d{6})?(?:-pre-restore)?\.json$/

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

function sanitizeLibrary(raw: unknown): Library | null {
  if (typeof raw !== 'object' || raw === null) return null
  const l = raw as Record<string, unknown>
  if (!Array.isArray(l.docs) || !Array.isArray(l.folders)) return null
  const folders: Folder[] = []
  for (const f of l.folders) {
    if (typeof f === 'object' && f !== null && typeof (f as Folder).id === 'string' && ID_RE.test((f as Folder).id) && typeof (f as Folder).name === 'string') {
      folders.push({ id: (f as Folder).id, name: normalizeTitle((f as Folder).name, '新建文件夹'), createdAt: Number((f as Folder).createdAt) || 0 })
    }
  }
  const ids = new Set(folders.map(f => f.id))
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
  private readonly docs = new Map<string, OutlineDoc>()
  private queue: Promise<unknown> = Promise.resolve()
  private loading: Promise<void> | undefined
  /** Problems found while loading (quarantined files etc.). */
  readonly warnings: string[] = []

  constructor(dir: string, now: () => number = () => Date.now()) {
    this.dir = dir
    this.now = now
  }

  private get libraryFile(): string { return join(this.dir, 'library.json') }
  private get docsDir(): string { return join(this.dir, 'docs') }
  private get backupsDir(): string { return join(this.dir, 'backups') }
  private docFile(id: string): string { return join(this.docsDir, `${id}.json`) }

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
    this.warnings.push(`${why}: 已隔离为 ${target}`)
    console.warn(`[dsh-mindmap] ${why}; quarantined as ${target}`)
  }

  private async load(): Promise<void> {
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
  }

  private async writeDoc(doc: OutlineDoc): Promise<void> {
    const problem = validateDoc(doc)
    if (problem !== null) throw new StorageError('invalid_input', `文档结构无效：${problem}`)
    await atomicWrite(this.docFile(doc.id), JSON.stringify(doc))
    this.docs.set(doc.id, doc)
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
    if (cached !== undefined) return cached
    const doc = await this.readDocFile(id)
    this.docs.set(id, doc)
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
      const now = this.now()
      const doc = createDoc(normalizeTitle(input.title), now, input.items ?? [])
      await this.writeDoc(doc)
      const meta: DocMeta = { id: doc.id, title: doc.title, folderId, favorite: false, createdAt: now, updatedAt: now }
      this.library.docs.push(meta)
      await this.writeLibrary()
      await this.dailyBackup()
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
      const now = this.now()
      const next: OutlineDoc = { ...doc, title: normalizeTitle(doc.title), revision: current.revision + 1, createdAt: current.createdAt, updatedAt: now }
      await this.writeDoc(next)
      meta.title = next.title
      meta.updatedAt = now
      await this.writeLibrary()
      await this.dailyBackup()
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

  /** Permanent delete; only trashed documents. */
  purgeDoc(id: string): Promise<void> {
    return this.serial(async () => {
      const meta = this.meta(id)
      if (meta.trashedAt === undefined) throw new StorageError('invalid_input', '只能永久删除回收站中的文档')
      await this.backupInternal('manual')
      this.library.docs = this.library.docs.filter(d => d.id !== id)
      await this.writeLibrary()
      this.docs.delete(id)
      await rm(this.docFile(id), { force: true })
    })
  }

  createFolder(name: unknown): Promise<Folder> {
    return this.serial(async () => {
      const folder: Folder = { id: newId(), name: normalizeTitle(name, '新建文件夹'), createdAt: this.now() }
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

  /** Delete a folder; its documents move back to the top level (never deleted). */
  deleteFolder(id: string): Promise<void> {
    return this.serial(async () => {
      if (!this.library.folders.some(f => f.id === id)) throw new StorageError('not_found', '文件夹不存在')
      this.library.folders = this.library.folders.filter(f => f.id !== id)
      for (const d of this.library.docs) if (d.folderId === id) d.folderId = null
      await this.writeLibrary()
    })
  }

  /** Title + node text search over non-trashed documents. */
  async search(query: string, limit = 100): Promise<SearchHit[]> {
    await this.ready()
    const hits: SearchHit[] = []
    for (const meta of this.library.docs) {
      if (meta.trashedAt !== undefined) continue
      if (hits.length >= limit) break
      try {
        const doc = await this.serial(() => this.loadDoc(meta.id))
        hits.push(...searchDoc(doc, meta.title, query, limit - hits.length))
      } catch { /* unreadable docs are skipped (already quarantined) */ }
    }
    return hits
  }

  // -------------------------------------------------------------- backups

  private async snapshot(): Promise<BackupFile> {
    const docs: OutlineDoc[] = []
    for (const meta of this.library.docs) {
      try { docs.push(await this.loadDoc(meta.id)) } catch { /* skip unreadable */ }
    }
    return { schema: 1, kind: 'dsh-mindmap-backup', createdAt: this.now(), library: structuredClone(this.library), docs }
  }

  private async backupInternal(kind: 'daily' | 'manual' | 'pre-restore'): Promise<BackupInfo> {
    const now = this.now()
    const name = kind === 'daily' ? `mindmap-${stamp(now, false)}.json` : `mindmap-${stamp(now, true)}${kind === 'pre-restore' ? '-pre-restore' : ''}.json`
    const contents = JSON.stringify(await this.snapshot())
    await atomicWrite(join(this.backupsDir, name), contents)
    await this.prune()
    return { name, size: Buffer.byteLength(contents), createdAt: now }
  }

  /** First write of a local day snapshots the whole library. */
  private async dailyBackup(): Promise<void> {
    const name = `mindmap-${stamp(this.now(), false)}.json`
    try {
      await stat(join(this.backupsDir, name))
    } catch (error) {
      if (!isEnoent(error)) return
      await this.backupInternal('daily').catch(e => console.warn('[dsh-mindmap] daily backup failed:', e))
    }
  }

  private async prune(): Promise<void> {
    const list = await this.listBackupsRaw()
    for (const old of list.slice(MAX_BACKUPS)) await rm(join(this.backupsDir, old.name), { force: true })
  }

  private async listBackupsRaw(): Promise<BackupInfo[]> {
    const out: BackupInfo[] = []
    for (const name of await readdir(this.backupsDir).catch(() => [] as string[])) {
      if (!BACKUP_RE.test(name)) continue
      const s = await stat(join(this.backupsDir, name)).catch(() => null)
      if (s !== null) out.push({ name, size: s.size, createdAt: s.mtimeMs })
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
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
   * "-pre-restore" backup, so a restore is itself reversible.
   */
  restore(source: { name: string } | { data: unknown }): Promise<{ docs: number; preRestore: string }> {
    return this.serial(async () => {
      let raw: unknown
      if ('name' in source) raw = JSON.parse(await this.readBackup(source.name))
      else raw = source.data
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
      for (const meta of library.docs) await this.writeDoc(byId.get(meta.id)!)
      const keep = new Set(library.docs.map(d => d.id))
      for (const f of await readdir(this.docsDir)) {
        const m = /^([a-z0-9-]{6,64})\.json$/.exec(f)
        if (m !== null && !keep.has(m[1]!)) await rm(join(this.docsDir, f), { force: true })
      }
      this.docs.clear()
      this.library = library
      await this.writeLibrary()
      return { docs: library.docs.length, preRestore: pre.name }
    })
  }
}
