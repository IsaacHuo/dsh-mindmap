/**
 * Bridge from the mind-map UI to the DSH conversation services (sessions,
 * workspaces, right sidebar, composer). Built once by the client entry from
 * whatever services are available; every member is optional and the UI hides
 * actions whose service is missing. Nothing here throws into React code.
 * @module dsh-mindmap/client/bridge
 */

/** Right-sidebar tab kind of the mind-map view. */
export const TAB_KIND = 'dsh-mindmap'

/** Where the right-sidebar view should open. */
export interface BesideTarget { docId?: string; nodeId?: string }

/** What the UI can ask of DSH. */
export interface HostBridge {
  /**
   * Create a session (in the workspace of `nearSessionId` when known) with
   * `prompt` as its draft and return its id; the caller navigates with
   * openSession. The user sends the draft; nothing is submitted automatically.
   */
  newSession?(prompt: string, nearSessionId?: string): Promise<string>
  /** Navigate to a session. */
  openSession?(id: string): void
  /** Title of a session when DSH knows it. */
  sessionTitle?(id: string): string | undefined
  /** Whether a session still exists (undefined = unknown). */
  sessionExists?(id: string): boolean | undefined
  /** Open the mind map in the right sidebar of the session on screen. */
  openBeside?(target: BesideTarget, sessionId?: string): boolean
}

/** Per-mount extras of the right-sidebar view. */
export interface ChatBridge {
  sessionId: string
  /** Insert text into this session's composer as a quote; false when it failed. */
  insertQuote(text: string, summary?: string): boolean
}

let current: HostBridge = {}
const listeners = new Set<() => void>()

/** Install the bridge (client entry). */
export function setBridge(next: HostBridge): void {
  current = next
  for (const l of listeners) l()
}

/** Current bridge. */
export function bridge(): HostBridge {
  return current
}

/** Subscribe to bridge replacement (used by useBridge). */
export function onBridge(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// ---------- DSH service faces (narrow, all unverified at the type level) ----------

interface SnapshotSource<T> { getSnapshot(): T }
interface SessionsFace {
  create(opts?: { workspaceId?: string; cwd?: string }): Promise<string>
  binding(id: string): { ctx: unknown } | undefined
  list?: SnapshotSource<{ byId?: Record<string, { title?: string; cwd?: string } | undefined> }>
}
interface WorkspacesFace { list?: SnapshotSource<{ items?: Array<{ workspaceId: string; sessionIds?: readonly string[] }> }> }
interface UiWorkspaceFace { openSession(id: string): void }
interface ConversationFace {
  input?: { requestDraftInitialization?(binding: unknown, opts: { prompt: string; whenDraftExists?: 'replace' | 'keep' }): unknown }
}
interface SidebarRightFace { openTab(kind: string, opts?: { params?: Record<string, unknown>; revealIfOpened?: boolean }): unknown }

/** Services the bridge can use (any may be missing). */
export interface BridgeServices {
  sessions?: SessionsFace
  workspaces?: WorkspacesFace
  uiWorkspace?: UiWorkspaceFace
  conversation?: ConversationFace
  sidebarRight?: SidebarRightFace
}

const warn = (what: string, error: unknown): void => console.warn('[dsh-mindmap] ' + what + ' failed:', error)

/** Build the bridge from DSH services. */
export function createBridge(s: BridgeServices): HostBridge {
  const out: HostBridge = {}
  const { sessions, workspaces, uiWorkspace, conversation, sidebarRight } = s
  if (uiWorkspace !== undefined) {
    out.openSession = id => { try { uiWorkspace.openSession(id) } catch (e) { warn('openSession', e) } }
  }
  if (sessions?.list !== undefined) {
    const list = sessions.list
    out.sessionTitle = id => {
      try { const t = list.getSnapshot().byId?.[id]?.title; return typeof t === 'string' && t.length > 0 ? t : undefined } catch { return undefined }
    }
    out.sessionExists = id => {
      try { const by = list.getSnapshot().byId; return by === undefined ? undefined : by[id] !== undefined } catch { return undefined }
    }
  }
  if (sidebarRight !== undefined) {
    out.openBeside = (target, sessionId) => {
      try {
        sidebarRight.openTab(TAB_KIND, { params: { ...target, ...(sessionId !== undefined ? { sessionId } : {}) }, revealIfOpened: true })
        return true
      } catch (e) { warn('openTab', e); return false }
    }
  }
  if (sessions !== undefined && uiWorkspace !== undefined) {
    out.newSession = async (prompt, near) => {
      let workspaceId: string | undefined
      let cwd: string | undefined
      if (near !== undefined) {
        try { workspaceId = workspaces?.list?.getSnapshot().items?.find(w => w.sessionIds?.includes(near) === true)?.workspaceId } catch { /* unknown */ }
        try { cwd = sessions.list?.getSnapshot().byId?.[near]?.cwd } catch { /* unknown */ }
      }
      const id = await sessions.create(workspaceId !== undefined ? { workspaceId } : cwd !== undefined ? { cwd } : {})
      try {
        const b = sessions.binding(id)
        if (b !== undefined) conversation?.input?.requestDraftInitialization?.(b, { prompt, whenDraftExists: 'replace' })
      } catch (e) { warn('draft', e) }
      return id
    }
  }
  return out
}
