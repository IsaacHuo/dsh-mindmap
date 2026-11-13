/**
 * Browser-side client for /dsh-mindplan/api (same origin as the DSH GUI).
 * @module dsh-mindplan/client/api
 */
import { ROUTE_PREFIX, type ApiErrorCode, type ApiResult, type BackupInfo, type CreateDocBody, type PatchMetaBody } from '../shared/api.ts'
import type { DocMeta, Folder, Library, OutlineDoc } from '../shared/model.ts'
import type { SearchHit } from '../shared/search.ts'

/** Failed API call. */
export class ApiError extends Error {
  readonly code: ApiErrorCode | 'network'
  readonly current?: OutlineDoc
  constructor(code: ApiErrorCode | 'network', message: string, current?: OutlineDoc) {
    super(message)
    this.code = code
    if (current !== undefined) this.current = current
  }
}

async function call<T>(path: string, body?: unknown, init: { keepalive?: boolean } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(ROUTE_PREFIX + path, body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: init.keepalive === true })
  } catch (error) {
    throw new ApiError('network', '无法连接到思维导图服务：' + (error instanceof Error ? error.message : String(error)))
  }
  let parsed: ApiResult<T>
  try {
    parsed = await res.json() as ApiResult<T>
  } catch {
    throw new ApiError('internal', `服务返回了无效响应 (HTTP ${res.status})`)
  }
  if (!parsed.ok) throw new ApiError(parsed.error.code, parsed.error.message, parsed.error.current)
  return parsed.value
}

export const api = {
  library: () => call<{ library: Library; warnings: string[] }>('/library'),
  doc: (id: string) => call<OutlineDoc>(`/docs/${id}`),
  createDoc: (body: CreateDocBody) => call<{ meta: DocMeta; doc: OutlineDoc }>('/docs', body),
  saveDoc: (doc: OutlineDoc, baseRevision: number, keepalive = false) => call<OutlineDoc>(`/docs/${doc.id}/save`, { doc, baseRevision }, { keepalive }),
  patchMeta: (id: string, body: PatchMetaBody) => call<{ meta: DocMeta; doc?: OutlineDoc }>(`/docs/${id}/meta`, body),
  trash: (id: string) => call<DocMeta>(`/docs/${id}/trash`, {}),
  restore: (id: string) => call<DocMeta>(`/docs/${id}/restore`, {}),
  purge: (id: string) => call<null>(`/docs/${id}/purge`, {}),
  createFolder: (name: string) => call<Folder>('/folders', { name }),
  renameFolder: (id: string, name: string) => call<Folder>(`/folders/${id}/rename`, { name }),
  deleteFolder: (id: string) => call<null>(`/folders/${id}/delete`, {}),
  search: (q: string) => call<SearchHit[]>('/search?q=' + encodeURIComponent(q)),
  backups: () => call<BackupInfo[]>('/backups'),
  backupNow: () => call<BackupInfo>('/backups/now', {}),
  restoreBackup: (name: string) => call<{ docs: number; preRestore: string }>(`/backups/${name}/restore`, {}),
  restoreFile: (data: unknown) => call<{ docs: number; preRestore: string }>('/restore', data),
  backupUrl: (name: string) => `${ROUTE_PREFIX}/backups/${encodeURIComponent(name)}`,
}
