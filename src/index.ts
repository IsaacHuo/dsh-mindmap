/**
 * Host loader entry for dsh-mindmap (思维导图). Mounts only the storage-backed
 * /dsh-mindmap/api routes on the shared DSH webserver: no agent tools, no
 * system-prompt sections, no model calls.
 *
 * Data directory: $DSH_MINDMAP_DIR, else <DSH_HOME or ~/.dsh>/dsh-mindmap.
 * Export shape: `name` / `inject` / `apply`, no default export.
 * @module dsh-mindmap
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ROUTE_PREFIX } from './shared/api.ts'
import { createHandler } from './host/routes.ts'
import { MindmapStorage } from './host/storage.ts'

/** Cordis plugin name. */
export const name = 'dsh-mindmap'

/** No hard dependencies; the webserver is awaited through ctx.inject below. */
export const inject: string[] = []

/** Narrow face of the DSH webserver service. */
interface WebServerFace {
  register(route: { kind: 'prefix' | 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }): () => void
}

/** Narrow face of the cordis context used here. */
interface ContextFace {
  inject(deps: string[], callback: (ctx: ContextFace & { webServer: WebServerFace }) => void): unknown
  effect(fn: () => () => void, label?: string): unknown
}

/** Resolve the data directory. */
export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_MINDMAP_DIR !== undefined && env.DSH_MINDMAP_DIR.length > 0) return resolve(env.DSH_MINDMAP_DIR)
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(resolve(home), 'dsh-mindmap')
}

/** Mount the host half. */
export function apply(ctx: ContextFace): void {
  const storage = new MindmapStorage(dataDirectory())
  void storage.ready().catch(error => console.warn('[dsh-mindmap] storage load failed:', error))
  const handler = createHandler(storage)
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'dsh-mindmap: routes')
  })
}
