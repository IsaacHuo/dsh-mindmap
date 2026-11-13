/**
 * Host loader entry for dsh-mindplan (思维导图). Mounts only the storage-backed
 * /dsh-mindplan/api routes on the shared DSH webserver: no agent tools, no
 * system-prompt sections, no model calls.
 *
 * Data directory: $DSH_MINDPLAN_DIR, else <DSH_HOME or ~/.dsh>/dsh-mindplan
 * (an existing <home>/dsh-mindmap from pre-release builds is reused in place).
 * Export shape: `name` / `inject` / `apply`, no default export.
 * @module dsh-mindplan
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ROUTE_PREFIX } from './shared/api.ts'
import { createHandler } from './host/routes.ts'
import { MindmapStorage } from './host/storage.ts'

/** Cordis plugin name. */
export const name = 'dsh-mindplan'

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
export function dataDirectory(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string {
  for (const key of ['DSH_MINDPLAN_DIR', 'DSH_MINDMAP_DIR'] as const) {
    const value = env[key]
    if (value !== undefined && value.length > 0) return resolve(value)
  }
  const home = resolve(env.DSH_HOME !== undefined && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh'))
  const current = join(home, 'dsh-mindplan')
  // Pre-release builds were named dsh-mindmap: keep using that directory in
  // place (never move or copy user data) when it exists and the new one does not.
  const legacy = join(home, 'dsh-mindmap')
  if (!exists(current) && exists(legacy)) return legacy
  return current
}

/** Mount the host half. */
export function apply(ctx: ContextFace): void {
  const storage = new MindmapStorage(dataDirectory())
  void storage.ready().catch(error => console.warn('[dsh-mindplan] storage load failed:', error))
  const handler = createHandler(storage)
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'dsh-mindplan: routes')
  })
}
