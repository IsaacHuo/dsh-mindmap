/**
 * /dsh-mindmap/api routes on the shared DSH webserver. JSON envelope
 * { ok, value | error }. Only GET and POST are used; every POST must carry a
 * JSON content type (a cross-origin page cannot send that without a CORS
 * preflight, which this server never grants), the Host header must name the
 * loopback interface (DNS-rebinding guard), a present Origin must match the
 * Host, and every path parameter is matched against a strict pattern.
 * @module dsh-mindmap/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ROUTE_PREFIX, type ApiErrorCode } from '../shared/api.ts'
import { parseMarkdown } from '../shared/markdown.ts'
import { parseOpml } from '../shared/opml.ts'
import { toItems, validateDoc, type OutlineDoc, type TreeItem } from '../shared/model.ts'
import { StorageError, type MindmapStorage } from './storage.ts'

/** Body limits per route kind. */
export const BODY_LIMITS = { save: 32 * 1024 * 1024, restore: 64 * 1024 * 1024, other: 1024 * 1024 } as const

const STATUS: Record<ApiErrorCode, number> = { invalid_input: 400, not_found: 404, conflict: 409, too_large: 413, internal: 500 }

const ID = '([a-z0-9-]{6,64})'
const DOC_RE = new RegExp('^/docs/' + ID + '$')
const DOC_ACTION_RE = new RegExp('^/docs/' + ID + '/(save|meta|trash|restore|purge)$')
const FOLDER_ACTION_RE = new RegExp('^/folders/' + ID + '/(rename|delete|move)$')
const BACKUP_RE = /^\/backups\/(mindmap-\d{8}(?:-\d{6})?(?:-(?:pre-restore|purge))?\.json)(\/restore)?$/
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function ok(res: ServerResponse, value: unknown): void {
  send(res, 200, { ok: true, value })
}

function fail(res: ServerResponse, code: ApiErrorCode, message: string, extra: Record<string, unknown> = {}): void {
  send(res, STATUS[code], { ok: false, error: { code, message, ...extra } })
}

/** Host name part of a Host header value (keeps IPv6 brackets). */
function hostName(value: string): string {
  const v = value.trim().toLowerCase()
  if (v.startsWith('[')) return v.slice(0, v.indexOf(']') + 1)
  const i = v.lastIndexOf(':')
  return i >= 0 ? v.slice(0, i) : v
}

/** Reject requests whose Host is not loopback or whose Origin is foreign. */
export function checkOrigin(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? '')
  if (host === '' || !LOOPBACK.has(hostName(host))) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(String(origin)).host.toLowerCase() === host.trim().toLowerCase()
  } catch {
    return false
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '')
  if (!type.toLowerCase().startsWith('application/json')) throw new StorageError('invalid_input', '请求必须是 application/json')
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw new StorageError('too_large', '请求体过大')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new StorageError('too_large', '请求体过大')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new StorageError('invalid_input', '请求体不是有效 JSON')
  }
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function limitFor(path: string): number {
  if (path === '/restore') return BODY_LIMITS.restore
  if (path === '/docs' || path.endsWith('/save')) return BODY_LIMITS.save
  return BODY_LIMITS.other
}

/** Build the prefix handler. */
export function createHandler(storage: MindmapStorage): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      if (!checkOrigin(req)) { send(res, 403, { ok: false, error: { code: 'invalid_input', message: '拒绝访问' } }); return }
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(ROUTE_PREFIX)) { fail(res, 'not_found', '未知路径'); return }
      const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      const method = req.method ?? 'GET'

      if (method === 'GET') {
        if (path === '/library') { const library = await storage.getLibrary(); ok(res, { library, warnings: await storage.takeWarnings() }); return }
        const doc = DOC_RE.exec(path)
        if (doc !== null) { ok(res, await storage.getDoc(doc[1]!)); return }
        if (path === '/search') { ok(res, await storage.search(String(url.searchParams.get('q') ?? '').slice(0, 200))); return }
        if (path === '/backups') { ok(res, await storage.listBackups()); return }
        if (path === '/health/quarantine') { ok(res, await storage.listQuarantine()); return }
        const backup = BACKUP_RE.exec(path)
        if (backup !== null && backup[2] === undefined) {
          const text = await storage.readBackup(backup[1]!)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="' + backup[1] + '"', 'cache-control': 'no-store' })
          res.end(text)
          return
        }
        fail(res, 'not_found', '未知路径')
        return
      }
      if (method !== 'POST') { fail(res, 'not_found', '不支持的方法'); return }
      const body = obj(await readBody(req, limitFor(path)))

      if (path === '/docs') {
        let items: TreeItem[] = []
        let title = body.title
        if (body.copy !== undefined) {
          const problem = validateDoc(body.copy)
          if (problem !== null) throw new StorageError('invalid_input', '文档结构无效：' + problem)
          const copy = body.copy as OutlineDoc
          items = toItems(copy, copy.nodes[copy.rootId]!.children)
          if (title === undefined || title === '') title = copy.title
        } else if (typeof body.markdown === 'string') {
          const parsed = parseMarkdown(body.markdown)
          items = parsed.items
          if (title === undefined || title === '') title = parsed.title
        } else if (typeof body.opml === 'string') {
          let parsed
          try { parsed = parseOpml(body.opml) } catch (error) { throw new StorageError('invalid_input', (error as Error).message) }
          items = parsed.items
          if (title === undefined || title === '') title = parsed.title
        }
        ok(res, await storage.createDoc({ title, folderId: body.folderId, items }))
        return
      }
      const action = DOC_ACTION_RE.exec(path)
      if (action !== null) {
        const id = action[1]!
        switch (action[2]) {
          case 'save': ok(res, await storage.saveDoc(id, body.doc, body.baseRevision)); return
          case 'meta': ok(res, await storage.patchMeta(id, body)); return
          case 'trash': ok(res, await storage.trashDoc(id)); return
          case 'restore': ok(res, await storage.restoreDoc(id)); return
          case 'purge': await storage.purgeDoc(id); ok(res, null); return
        }
      }
      if (path === '/trash/empty') { ok(res, await storage.emptyTrash()); return }
      if (path === '/folders') { ok(res, await storage.createFolder(body.name, body.parentId ?? null)); return }
      const folder = FOLDER_ACTION_RE.exec(path)
      if (folder !== null) {
        if (folder[2] === 'rename') ok(res, await storage.renameFolder(folder[1]!, body.name))
        else if (folder[2] === 'move') ok(res, await storage.moveFolder(folder[1]!, body.parentId ?? null))
        else { await storage.deleteFolder(folder[1]!); ok(res, null) }
        return
      }
      if (path === '/backups/now') { ok(res, await storage.backupNow()); return }
      const backup = BACKUP_RE.exec(path)
      if (backup !== null && backup[2] === '/restore') { ok(res, await storage.restore({ name: backup[1]! })); return }
      if (path === '/restore') { ok(res, await storage.restore({ data: body })); return }
      fail(res, 'not_found', '未知路径')
    } catch (error) {
      if (error instanceof StorageError) {
        fail(res, error.code, error.message, error.current !== undefined ? { current: error.current } : {})
        return
      }
      console.error('[dsh-mindmap] route failed:', error)
      fail(res, 'internal', '服务器内部错误')
    }
  }
}
