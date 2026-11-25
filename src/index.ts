/**
 * Host loader entry for dsh-mindmap (思维导图). Mounts the storage-backed
 * /dsh-mindmap/api routes on the shared DSH webserver, the `mindmap` agent
 * tool (read + tracked, non-destructive edits) and a short system-prompt
 * section describing it. Each is optional: a missing service skips its part.
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
import { runMindmapTool, TOOL_DESCRIPTION, TOOL_NAME, TOOL_PARAMETERS } from './host/tools.ts'

/** Cordis plugin name. */
export const name = 'dsh-mindmap'

/** No hard dependencies; the webserver is awaited through ctx.inject below. */
export const inject: string[] = []

/** Narrow face of the DSH webserver service. */
interface WebServerFace {
  register(route: { kind: 'prefix' | 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }): () => void
}

/** Narrow face of the DSH tools service (plain ToolDefinition, no dsh-tools import). */
interface ToolsFace {
  register(def: {
    name: string
    description: string
    parameters: unknown
    output: { schema: unknown; render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> }
    execute(args: unknown, exec: { agent?: { id?: string } }): Promise<unknown>
  }): () => void
}

/** Narrow face of the DSH system-prompt service. */
interface SystemPromptFace {
  section(def: { name: string; order: number; text: string }): () => void
}

/** Services this plugin may use. */
interface Services { webServer: WebServerFace; tools: ToolsFace; systemPrompt: SystemPromptFace }

/** Narrow face of the cordis context used here. */
interface ContextFace {
  inject<K extends keyof Services>(deps: K[], callback: (ctx: ContextFace & Pick<Services, K>) => void): unknown
  effect(fn: () => () => void, label?: string): unknown
}

/** System-prompt section: when to reach for the tool and the review rules. */
export const PROMPT_SECTION = [
  '## Mind maps (思维导图)',
  `The user keeps outlines / mind maps in the 思维导图 plugin. Use the \`${TOOL_NAME}\` tool to list, read, search and edit them; never look for their files on disk.`,
  'A reference like mindmap://<docId>/<nodeId> in a message points at a document or node: read it with the tool before answering about it.',
  'Your edits are shown to the user as pending changes (added / edited with the original kept / struck through for deletion) and only the user accepts or rejects them, so describe what you changed after an apply.',
].join('\n')

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
  ctx.inject(['tools'], toolCtx => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: TOOL_PARAMETERS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string' ? (value as { text: string }).text : JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.id
        const r = await runMindmapTool(storage, args, typeof sessionId === 'string' ? { sessionId } : {})
        return { ok: r.ok, text: r.text, ...(r.data !== undefined ? { data: r.data } : {}) }
      },
    }), 'dsh-mindmap: tool')
  })
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({ name: 'dsh-mindmap:guide', order: 900, text: PROMPT_SECTION }), 'dsh-mindmap: prompt')
  })
}
