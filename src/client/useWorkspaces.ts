/**
 * React access to the DSH workspace list through the bridge.
 * @module dsh-mindmap/client/useWorkspaces
 */
import { useCallback, useSyncExternalStore } from 'react'
import type { WorkspaceList } from './bridge.ts'
import { useBridge } from './aiActions.tsx'

const noop = (): (() => void) => () => {}
const none = (): WorkspaceList | null => null

/** Live workspace list, or null when DSH does not provide the service. */
export function useWorkspaces(): WorkspaceList | null {
  const b = useBridge()
  const read = b.workspaces
  const sub = b.onWorkspaces
  const subscribe = useCallback((fn: () => void) => (sub !== undefined ? sub(fn) : noop()), [sub])
  const get = read !== undefined ? read : none
  return useSyncExternalStore(subscribe, get, get)
}
