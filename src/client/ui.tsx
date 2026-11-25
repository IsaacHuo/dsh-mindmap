/**
 * Small UI primitives: icons, popup menu, modal dialogs (confirm / prompt) and
 * a toast. All plain React, no third-party components.
 * @module dsh-mindmap/client/ui
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

const PATHS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  folderPlus: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  doc: 'M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  chevron: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  menu: 'M4 6h16M4 12h16M4 18h16',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  center: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2v3M12 19v3M2 12h3M19 12h3',
  minus: 'M5 12h14',
  expand: 'M7 10l5-5 5 5M7 14l5 5 5-5',
  collapse: 'M7 5l5 5 5-5M7 19l5-5 5 5',
  backup: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  x: 'M6 6l12 12M18 6L6 18',
  mindmap: 'M9 12h3M12 12c2 0 2-5 4-5h1M12 12c2 0 2 5 4 5h1M4 10h5v4H4zM17 5h4v4h-4zM17 15h4v4h-4z',
  outline: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
}

/** Stroke icon. */
export function Icon(props: { name: string; size?: number }): ReactNode {
  const size = props.size ?? 16
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[props.name] ?? ''} />
    </svg>
  )
}

/** One popup-menu entry. */
export type MenuEntry =
  | { kind?: 'item'; label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; shortcut?: string }
  | { kind: 'sep' }
  | { kind: 'label'; label: string }

/** Prefix a non-empty group of entries with a separator. */
export function withSep(items: MenuEntry[]): MenuEntry[] {
  return items.length > 0 ? [{ kind: 'sep' }, ...items] : []
}

/** Menu state helper. */
export interface MenuState { x: number; y: number; items: MenuEntry[] }

/** Fixed-position popup menu; closes on outside click, Escape, blur or resize. */
export function PopupMenu(props: { x: number; y: number; items: MenuEntry[]; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: props.x, y: props.y })
  const onClose = props.onClose
  // Give focus back to whatever had it when the menu opened (row, textarea, button).
  const opener = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement)
  useEffect(() => () => {
    const el = opener.current as HTMLElement | null
    if (el !== null && typeof el.focus === 'function' && document.contains(el) && (document.activeElement === null || document.activeElement === document.body || ref.current?.contains(document.activeElement) === true)) el.focus({ preventScroll: true })
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 4)) })
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [props.x, props.y])
  useEffect(() => {
    const down = (e: MouseEvent): void => { if (ref.current !== null && !ref.current.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
      if (e.key === 'Tab') { e.preventDefault(); onClose(); return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const list = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        if (list.length === 0) return
        const at = list.indexOf(document.activeElement as HTMLButtonElement)
        list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1) + list.length) % list.length]?.focus()
      }
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])
  return (
    <div ref={ref} className="mm-menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={e => e.preventDefault()}>
      {props.items.map((item, i) => {
        if (item.kind === 'sep') return <div key={i} className="mm-menu-sep" role="separator" />
        if (item.kind === 'label') return <div key={i} className="mm-menu-label">{item.label}</div>
        return (
          <button key={i} type="button" role="menuitem" disabled={item.disabled} className={'mm-menu-item' + (item.danger === true ? ' mm-danger' : '')}
            onClick={() => { onClose(); item.onSelect() }}>
            {item.label}{item.shortcut !== undefined ? <span className="mm-menu-key">{item.shortcut}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

export interface DialogApi {
  confirm(opts: { title: string; message?: string; ok?: string; danger?: boolean }): Promise<boolean>
  prompt(opts: { title: string; value?: string; placeholder?: string; ok?: string; multiline?: boolean; message?: string }): Promise<string | null>
  show(opts: { title: string; body: (close: () => void) => ReactNode }): void
  /** Short notice; with an action (e.g. 撤销) it stays longer and shows a button. */
  toast(message: string, action?: ToastAction): void
}

/** Button shown inside a toast. */
export interface ToastAction { label: string; onClick: () => void }

const DialogContext = createContext<DialogApi | null>(null)

/** Access confirm/prompt/toast. */
export function useDialogs(): DialogApi {
  const api = useContext(DialogContext)
  if (api === null) throw new Error('useDialogs outside DialogHost')
  return api
}

type Pending =
  | { kind: 'confirm'; title: string; message?: string; ok: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; value: string; placeholder: string; ok: string; multiline: boolean; message?: string; resolve: (v: string | null) => void }
  | { kind: 'custom'; title: string; body: (close: () => void) => ReactNode }

/** Rendering state shared between DialogHost and DialogOutlet. */
interface DialogView { stack: Pending[]; toast: { message: string; action?: ToastAction } | null; pop: (p: Pending) => void; clearToast: () => void }
const DialogViewContext = createContext<DialogView | null>(null)

/**
 * Provides dialogs to its subtree. Rendering happens in <DialogOutlet>, which
 * must sit inside .mm-app so the --mm-* theme variables and positioning apply.
 * Dialogs stack: a confirm opened from a panel returns to that panel.
 */
export function DialogHost(props: { children: ReactNode }): ReactNode {
  const [stack, setStack] = useState<Pending[]>([])
  const [toast, setToast] = useState<{ message: string; action?: ToastAction } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const push = useCallback((p: Pending) => setStack(s => [...s, p]), [])
  const api = useMemo<DialogApi>(() => ({
    confirm: o => new Promise<boolean>(resolve => push({ kind: 'confirm', title: o.title, message: o.message, ok: o.ok ?? '确定', danger: o.danger === true, resolve })),
    prompt: o => new Promise<string | null>(resolve => push({ kind: 'prompt', title: o.title, value: o.value ?? '', placeholder: o.placeholder ?? '', ok: o.ok ?? '确定', multiline: o.multiline === true, message: o.message, resolve })),
    show: o => push({ kind: 'custom', title: o.title, body: o.body }),
    toast: (message, action) => {
      setToast(action === undefined ? { message } : { message, action })
      window.clearTimeout(toastTimer.current)
      toastTimer.current = window.setTimeout(() => setToast(null), action === undefined ? 2600 : 6000)
    },
  }), [push])
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])
  const view = useMemo<DialogView>(() => ({
    stack,
    toast,
    pop: p => setStack(s => s.filter(x => x !== p)),
    clearToast: () => { setToast(null); window.clearTimeout(toastTimer.current) },
  }), [stack, toast])
  return (
    <DialogContext.Provider value={api}>
      <DialogViewContext.Provider value={view}>{props.children}</DialogViewContext.Provider>
    </DialogContext.Provider>
  )
}

/** Renders the top dialog and the toast; place it inside .mm-app. */
export function DialogOutlet(): ReactNode {
  const v = useContext(DialogViewContext)
  if (v === null) return null
  const top = v.stack[v.stack.length - 1]
  const toast = v.toast
  return (
    <>
      {top !== undefined ? <Dialog key={v.stack.length + ':' + top.title} pending={top} onDone={() => v.pop(top)} /> : null}
      {toast !== null ? (
        <div className="mm-toast" role="status">
          <span>{toast.message}</span>
          {toast.action !== undefined ? <button type="button" className="mm-toast-btn" onClick={() => { const a = toast.action; v.clearToast(); a?.onClick() }}>{toast.action.label}</button> : null}
        </div>
      ) : null}
    </>
  )
}

function Dialog(props: { pending: Pending; onDone: () => void }): ReactNode {
  const p = props.pending
  const [value, setValue] = useState(p.kind === 'prompt' ? p.value : '')
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    if (p.kind === 'prompt') { inputRef.current?.focus(); inputRef.current?.select() }
    else if (okRef.current !== null) okRef.current.focus()
    else panelRef.current?.querySelector<HTMLElement>('button')?.focus()
    return () => { if (prev !== null && document.contains(prev)) prev.focus({ preventScroll: true }) }
  }, [p])
  const finish = (ok: boolean): void => {
    props.onDone()
    if (p.kind === 'confirm') p.resolve(ok)
    else if (p.kind === 'prompt') p.resolve(ok ? value : null)
  }
  const onKey = (e: ReactKeyboardEvent): void => {
    // Esc / Enter during IME composition belong to the IME (dismiss candidates).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return }
    if (e.key === 'Tab') {
      // Focus trap: keep Tab inside the dialog.
      const list = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select,a[href],[tabindex="0"]') ?? [])
      if (list.length === 0) { e.preventDefault(); return }
      const at = list.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (at <= 0 ? list.length - 1 : at - 1) : (at === -1 || at === list.length - 1 ? 0 : at + 1)
      e.preventDefault()
      list[next]!.focus()
      return
    }
    const multiline = p.kind === 'prompt' && p.multiline
    if (e.key === 'Enter' && p.kind !== 'custom' && !e.nativeEvent.isComposing && e.keyCode !== 229 && (!multiline || e.ctrlKey || e.metaKey)) {
      if ((e.target as HTMLElement).tagName === 'BUTTON' && !(e.ctrlKey || e.metaKey)) return
      e.preventDefault(); finish(true)
    }
  }
  return (
    <div className="mm-modal-mask" onMouseDown={e => { if (e.target === e.currentTarget) finish(false) }} onKeyDown={onKey}>
      <div ref={panelRef} className="mm-modal" tabIndex={-1} role="dialog" aria-modal="true" aria-label={p.title}>
        <h3>{p.title}</h3>
        <div className="mm-modal-body">
          {p.kind === 'confirm' && p.message !== undefined ? <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{p.message}</p> : null}
          {p.kind === 'prompt' && p.message !== undefined ? <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap', color: 'var(--mm-sub)' }}>{p.message}</p> : null}
          {p.kind === 'prompt' && p.multiline ? <textarea ref={inputRef} className="mm-modal-area" aria-label={p.title} value={value} placeholder={p.placeholder} rows={10} onChange={e => setValue(e.target.value)} /> : null}
          {p.kind === 'prompt' && !p.multiline ? <input ref={inputRef} type="text" aria-label={p.title} value={value} placeholder={p.placeholder} onChange={e => setValue(e.target.value)} /> : null}
          {p.kind === 'custom' ? p.body(props.onDone) : null}
        </div>
        {p.kind !== 'custom' ? (
          <div className="mm-modal-foot">
            <button type="button" className="mm-btn" onClick={() => finish(false)}>取消</button>
            <button ref={okRef} type="button" className={'mm-btn mm-primary' + (p.kind === 'confirm' && p.danger ? ' mm-danger' : '')} onClick={() => finish(true)}>{p.ok}</button>
          </div>
        ) : (
          <div className="mm-modal-foot"><button type="button" className="mm-btn" onClick={props.onDone}>关闭</button></div>
        )}
      </div>
    </div>
  )
}

/** Relative time in Chinese. */
export function relTime(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms)
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分钟前'
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前'
  if (d < 7 * 86_400_000) return Math.floor(d / 86_400_000) + ' 天前'
  const t = new Date(ms)
  const y = new Date(now).getFullYear() === t.getFullYear() ? '' : t.getFullYear() + '/'
  return y + (t.getMonth() + 1) + '/' + t.getDate()
}

/** Trigger a browser download. */
export function download(name: string, data: Blob): void {
  const url = URL.createObjectURL(data)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Safe file name. */
export function fileName(title: string, ext: string): string {
  const base = title.replace(/[\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 80) || '未命名文档'
  return base + '.' + ext
}
