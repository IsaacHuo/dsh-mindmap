/**
 * Minimal inline Markdown for display: **bold**, *italic*, ~~strike~~,
 * inline code, [text](http…) and bare http(s) links, #tags. Produces React nodes,
 * never HTML strings; only http(s) URLs become links.
 * @module dsh-mindmap/client/inline
 */
import type { ReactNode } from 'react'

const TOKEN = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(~~[^~\n]+?~~)|(\*[^*\s][^*\n]*?\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?，。；：！？])|((?:^|(?<=\s))#[^\s#]{1,40})/g

function openLink(url: string): (e: { preventDefault(): void; stopPropagation(): void }) => void {
  return e => {
    e.preventDefault()
    e.stopPropagation()
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/** Render one text into inline nodes. */
export function renderInline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const s = m[0]
    const key = keyBase + '-' + k++
    if (m[1] !== undefined) out.push(<code key={key} className="mm-code">{s.slice(1, -1)}</code>)
    else if (m[2] !== undefined) out.push(<strong key={key}>{renderInline(s.slice(2, -2), key)}</strong>)
    else if (m[3] !== undefined) out.push(<s key={key}>{renderInline(s.slice(2, -2), key)}</s>)
    else if (m[4] !== undefined) out.push(<em key={key}>{renderInline(s.slice(1, -1), key)}</em>)
    else if (m[5] !== undefined) {
      const close = s.indexOf('](')
      const url = s.slice(close + 2, -1)
      out.push(<a key={key} href={url} className="mm-link" onMouseDown={e => e.stopPropagation()} onClick={openLink(url)}>{s.slice(1, close)}</a>)
    } else if (m[6] !== undefined) out.push(<a key={key} href={s} className="mm-link" onMouseDown={e => e.stopPropagation()} onClick={openLink(s)}>{s}</a>)
    else out.push(<span key={key} className="mm-tag">{s}</span>)
    last = at + s.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export { plainText } from './plain.ts'
