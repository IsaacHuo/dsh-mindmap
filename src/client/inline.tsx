/**
 * Minimal inline Markdown for display: **bold**, *italic*, ~~strike~~,
 * inline code, [text](http…) and bare http(s) links, #tags. Produces React nodes,
 * never HTML strings; only http(s) URLs become links. Optional find
 * highlights (source offsets) render as <mark class="mm-find">; optional
 * onTag makes #tags clickable.
 * @module dsh-mindmap/client/inline
 */
import type { ReactNode } from 'react'

const TOKEN = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(~~[^~\n]+?~~)|(\*[^*\s][^*\n]*?\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?，。；：！？])|((?:^|(?<=\s))#[^\s#]{1,40})/g

/** A highlighted source range (find match). */
export interface InlineMark { start: number; end: number; current?: boolean }

/** Optional rendering extras. */
export interface InlineOptions {
  /** Ranges in source offsets to wrap in <mark class="mm-find">. */
  marks?: readonly InlineMark[]
  /** Called with the tag (e.g. '#work') when a #tag is clicked. */
  onTag?: (tag: string) => void
}

function openLink(url: string): (e: { preventDefault(): void; stopPropagation(): void }) => void {
  return e => {
    e.preventDefault()
    e.stopPropagation()
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/** Plain text at source offset 'base', split around highlight marks. */
function plain(text: string, base: number, key: string, marks: readonly InlineMark[] | undefined): ReactNode[] {
  if (marks === undefined || marks.length === 0) return [text]
  const out: ReactNode[] = []
  let pos = 0
  let k = 0
  for (const m of marks) {
    const s = Math.max(m.start - base, pos)
    const e = Math.min(m.end - base, text.length)
    if (e <= s) continue
    if (s > pos) out.push(text.slice(pos, s))
    out.push(<mark key={key + 'm' + k++} className={m.current === true ? 'mm-find mm-find-cur' : 'mm-find'}>{text.slice(s, e)}</mark>)
    pos = e
  }
  if (pos < text.length) out.push(text.slice(pos))
  return out
}

function render(text: string, base: number, keyBase: string, opts: InlineOptions | undefined): ReactNode[] {
  const marks = opts?.marks
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0
    const key = keyBase + '-' + k++
    if (at > last) out.push(...plain(text.slice(last, at), base + last, key + 'p', marks))
    const s = m[0]
    if (m[1] !== undefined) out.push(<code key={key} className="mm-code">{plain(s.slice(1, -1), base + at + 1, key, marks)}</code>)
    else if (m[2] !== undefined) out.push(<strong key={key}>{render(s.slice(2, -2), base + at + 2, key, opts)}</strong>)
    else if (m[3] !== undefined) out.push(<s key={key}>{render(s.slice(2, -2), base + at + 2, key, opts)}</s>)
    else if (m[4] !== undefined) out.push(<em key={key}>{render(s.slice(1, -1), base + at + 1, key, opts)}</em>)
    else if (m[5] !== undefined) {
      const close = s.indexOf('](')
      const url = s.slice(close + 2, -1)
      out.push(<a key={key} href={url} className="mm-link" onMouseDown={e => e.stopPropagation()} onClick={openLink(url)}>{plain(s.slice(1, close), base + at + 1, key, marks)}</a>)
    } else if (m[6] !== undefined) out.push(<a key={key} href={s} className="mm-link" onMouseDown={e => e.stopPropagation()} onClick={openLink(s)}>{plain(s, base + at, key, marks)}</a>)
    else {
      const onTag = opts?.onTag
      out.push(onTag === undefined
        ? <span key={key} className="mm-tag">{plain(s, base + at, key, marks)}</span>
        : <span key={key} className="mm-tag mm-tag-click" title={'筛选 ' + s} onMouseDown={e => { e.stopPropagation(); e.preventDefault() }} onClick={e => { e.stopPropagation(); onTag(s) }}>{plain(s, base + at, key, marks)}</span>)
    }
    last = at + s.length
  }
  if (last < text.length) out.push(...plain(text.slice(last), base + last, keyBase + '-t', marks))
  return out
}

/** Render one text into inline nodes. */
export function renderInline(text: string, keyBase = 'i', opts?: InlineOptions): ReactNode[] {
  const marks = opts?.marks !== undefined ? [...opts.marks].sort((a, b) => a.start - b.start) : undefined
  return render(text, 0, keyBase, marks === opts?.marks ? opts : { ...opts, marks })
}

export { plainText } from './plain.ts'
