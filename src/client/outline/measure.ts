/**
 * Caret geometry of a wrapped <textarea>: a hidden mirror <div> copies the
 * textarea's text metrics and wraps every UTF-16 unit in a span, so each
 * caret offset gets a CaretBox. Tops are quantized to line-height rows so
 * fallback fonts (CJK, emoji) with taller boxes still map to one line.
 * @module dsh-mindmap/client/outline/measure
 */
import type { CaretBox } from './helpers.ts'

const COPY = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch', 'letter-spacing', 'word-spacing',
  'line-height', 'text-transform', 'text-indent', 'tab-size', 'word-break', 'overflow-wrap', 'direction',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
]

/** Longest text measured; longer texts fall back to logical lines (null). */
export const MAX_MEASURE = 5000

/** Boxes for caret offsets 0..value.length (left/top relative to the textarea), or null. */
export function caretBoxes(el: HTMLTextAreaElement): CaretBox[] | null {
  const text = el.value
  if (text.length > MAX_MEASURE || typeof getComputedStyle !== 'function') return null
  const doc = el.ownerDocument
  const cs = getComputedStyle(el)
  const m = doc.createElement('div')
  const st = m.style
  for (const p of COPY) st.setProperty(p, cs.getPropertyValue(p))
  st.position = 'absolute'
  st.visibility = 'hidden'
  st.pointerEvents = 'none'
  st.left = '-99999px'
  st.top = '0'
  st.boxSizing = 'border-box'
  st.borderStyle = 'solid'
  st.borderColor = 'transparent'
  st.width = el.offsetWidth + 'px'
  st.height = 'auto'
  st.overflow = 'hidden'
  st.whiteSpace = 'pre-wrap'
  const spans: HTMLSpanElement[] = []
  const owner: number[] = []
  for (let i = 0; i < text.length; i++) {
    const s = doc.createElement('span')
    const c = text.charCodeAt(i)
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < text.length
    s.textContent = pair ? text.slice(i, i + 2) : text[i]!
    m.appendChild(s)
    spans.push(s)
    owner.push(spans.length - 1)
    if (pair) { owner.push(spans.length - 1); i++ }
  }
  const end = doc.createElement('span')
  end.textContent = '\u200b'
  m.appendChild(end)
  spans.push(end)
  owner.push(spans.length - 1)
  doc.body.appendChild(m)
  try {
    const fs = parseFloat(cs.fontSize)
    const lh = parseFloat(cs.lineHeight) || (Number.isFinite(fs) ? fs * 1.2 : 20)
    const pad = parseFloat(cs.paddingTop) || 0
    const measured = spans.map(s => {
      const center = s.offsetTop + s.offsetHeight / 2 - pad
      return { top: Math.max(0, Math.floor(center / lh)) * lh, left: s.offsetLeft }
    })
    return owner.map(o => measured[o]!)
  } finally {
    m.remove()
  }
}
