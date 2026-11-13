/**
 * Wire contract between the browser half and the host routes.
 * @module dsh-mindplan/shared/api
 */
import type { DocMeta, Folder, Library, OutlineDoc } from './model.ts'
import type { SearchHit } from './search.ts'

/** Route prefix on the shared DSH webserver. */
export const ROUTE_PREFIX = '/dsh-mindplan/api'

/** Error codes. */
export type ApiErrorCode = 'invalid_input' | 'not_found' | 'conflict' | 'too_large' | 'internal'

/** Response envelope. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: { code: ApiErrorCode; message: string; current?: OutlineDoc } }

export interface CreateDocBody { title?: string; folderId?: string | null; markdown?: string; opml?: string }
export interface SaveDocBody { doc: OutlineDoc; baseRevision: number }
export interface PatchMetaBody { title?: string; folderId?: string | null; favorite?: boolean }
export interface BackupInfo { name: string; size: number; createdAt: number }
export interface BackupFile { schema: 1; kind: 'dsh-mindplan-backup'; createdAt: number; library: Library; docs: OutlineDoc[] }
export type { DocMeta, Folder, Library, OutlineDoc, SearchHit }
