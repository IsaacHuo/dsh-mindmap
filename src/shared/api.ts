/**
 * Wire contract between the browser half and the host routes.
 * @module dsh-mindmap/shared/api
 */
import type { DocMeta, Folder, Library, OutlineDoc } from './model.ts'
import type { SearchHit } from './search.ts'

/** Route prefix on the shared DSH webserver. */
export const ROUTE_PREFIX = '/dsh-mindmap/api'

/** Error codes. */
export type ApiErrorCode = 'invalid_input' | 'not_found' | 'conflict' | 'too_large' | 'internal'

/** Response envelope. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: { code: ApiErrorCode; message: string; current?: OutlineDoc } }

export interface CreateDocBody { title?: string; folderId?: string | null; markdown?: string; opml?: string; /** Duplicate this content ("save as copy" on conflict). */ copy?: OutlineDoc }
export interface SaveDocBody { doc: OutlineDoc; baseRevision: number }
export interface PatchMetaBody { title?: string; folderId?: string | null; favorite?: boolean }
export type BackupKind = 'daily' | 'manual' | 'pre-restore' | 'purge'
export interface BackupInfo { name: string; size: number; createdAt: number; kind?: BackupKind }
export interface QuarantinedFile { name: string; size: number; createdAt: number }
export interface LibraryResponse { library: Library; warnings: string[] }
export interface BackupFile { schema: 1; kind: 'dsh-mindmap-backup'; createdAt: number; library: Library; docs: OutlineDoc[] }
export type { DocMeta, Folder, Library, OutlineDoc, SearchHit }
