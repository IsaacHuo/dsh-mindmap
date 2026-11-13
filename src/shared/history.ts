/**
 * Snapshot undo/redo. States are immutable documents, so a snapshot is just a
 * reference. Consecutive edits that share a merge key (typing in one node)
 * within MERGE_MS collapse into a single undo step.
 * @module dsh-mindmap/shared/history
 */

/** Caret position to restore with a snapshot. */
export interface Selection {
  nodeId: string
  caret: number
}

/** One stored step. */
export interface HistoryEntry<T> {
  state: T
  selection: Selection | null
}

/** Typing merge window. */
export const MERGE_MS = 1000

/** Bounded undo/redo stacks. */
export class History<T> {
  private past: Array<HistoryEntry<T>> = []
  private future: Array<HistoryEntry<T>> = []
  private lastKey: string | null = null
  private lastAt = 0
  private readonly limit: number
  constructor(limit = 200) {
    this.limit = limit
  }

  /** Record `before` (the state prior to an edit). Returns false when merged into the previous step. */
  record(before: T, selection: Selection | null, key: string | null = null, now = Date.now()): boolean {
    this.future = []
    const merge = key !== null && key === this.lastKey && now - this.lastAt < MERGE_MS
    this.lastKey = key
    this.lastAt = now
    if (merge) return false
    this.past.push({ state: before, selection })
    if (this.past.length > this.limit) this.past.shift()
    return true
  }

  /** End the current typing run so the next edit starts a new step. */
  breakMerge(): void {
    this.lastKey = null
  }

  undo(current: T, selection: Selection | null): HistoryEntry<T> | null {
    const entry = this.past.pop()
    if (entry === undefined) return null
    this.future.push({ state: current, selection })
    this.lastKey = null
    return entry
  }

  redo(current: T, selection: Selection | null): HistoryEntry<T> | null {
    const entry = this.future.pop()
    if (entry === undefined) return null
    this.past.push({ state: current, selection })
    this.lastKey = null
    return entry
  }

  canUndo(): boolean { return this.past.length > 0 }
  canRedo(): boolean { return this.future.length > 0 }

  clear(): void {
    this.past = []
    this.future = []
    this.lastKey = null
  }
}
