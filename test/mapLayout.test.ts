import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OutlineDoc, OutlineNode } from '../src/shared/model.ts'
import { docMapLayout, ellipsize, layoutMap, mapToSvg, MAX_LINES, MAX_TEXT_W, pngFits, wrap, type MapLayout, type Measure } from '../src/client/mapLayout.ts'

const measure: Measure = (t, _b, size = 14) => t.length * 8 * size / 14

/** Build a doc from nested [text, children] specs without recursion limits. */
function makeDoc(top: Array<{ text: string; kids?: number | string[] }>): OutlineDoc {
  const nodes: Record<string, OutlineNode> = {}
  const root: OutlineNode = { id: 'root', text: '', children: [] }
  nodes.root = root
  top.forEach((t, i) => {
    const id = 't' + i
    nodes[id] = { id, text: t.text, children: [] }
    root.children.push(id)
    const kids = typeof t.kids === 'number' ? Array.from({ length: t.kids }, (_, j) => t.text + '.' + j) : t.kids ?? []
    kids.forEach((k, j) => {
      const cid = id + '-' + j
      nodes[cid] = { id: cid, text: k, children: [] }
      nodes[id]!.children.push(cid)
    })
  })
  return { schema: 1, id: 'doc-test', title: 'T', rootId: 'root', nodes, revision: 0, createdAt: 0, updatedAt: 0 }
}

const sideHeight = (L: MapLayout, side: -1 | 1): number => {
  let lo = Infinity
  let hi = -Infinity
  for (const n of L.nodes) if (n.depth > 0 && n.side === side) { lo = Math.min(lo, n.y); hi = Math.max(hi, n.y + n.h) }
  return hi > lo ? hi - lo : 0
}

test('20000-deep chain lays out without recursion', () => {
  const nodes: Record<string, OutlineNode> = { root: { id: 'root', text: '', children: ['n0'] } }
  const N = 20000
  for (let i = 0; i < N; i++) nodes['n' + i] = { id: 'n' + i, text: 'x' + i, children: i + 1 < N ? ['n' + (i + 1)] : [] }
  const doc: OutlineDoc = { schema: 1, id: 'deep-doc', title: 'deep', rootId: 'root', nodes, revision: 0, createdAt: 0, updatedAt: 0 }
  for (const layout of ['right', 'both'] as const) {
    const L = layoutMap(doc, 'root', 'deep', measure, { layout })
    assert.equal(L.nodes.length, N + 1)
    assert.ok(Number.isFinite(L.width) && Number.isFinite(L.height))
    assert.equal(L.byId.get('n' + (N - 1))!.depth, N)
  }
  // Collapsed deep subtree: hidden count is iterative too.
  const c = { ...doc, nodes: { ...nodes, n0: { ...nodes.n0!, collapsed: true } } }
  const L = layoutMap(c, 'root', 'deep', measure)
  assert.equal(L.byId.get('n0')!.hidden, N - 1)
  assert.equal(L.nodes.length, 2)
})

test('both: depth-1 subtrees balanced between sides', () => {
  const doc = makeDoc([{ text: 'a', kids: 9 }, { text: 'b', kids: 1 }, { text: 'c', kids: 4 }, { text: 'd', kids: 4 }, { text: 'e', kids: 2 }, { text: 'f', kids: 0 }])
  const L = layoutMap(doc, 'root', 'T', measure, { layout: 'both' })
  const right = sideHeight(L, 1)
  const left = sideHeight(L, -1)
  assert.ok(right > 0 && left > 0)
  const biggest = Math.max(...L.nodes.filter(n => n.depth === 1).map(n => n.h))
  // Greedy bound: difference ≤ tallest single subtree (9 kids block).
  assert.ok(Math.abs(right - left) <= 9 * (34 + 12), 'diff ' + Math.abs(right - left))
  assert.ok(biggest > 0)
  const root = L.byId.get('root')!
  for (const n of L.nodes) {
    if (n.depth === 0) continue
    if (n.side > 0) assert.ok(n.x >= root.x + root.w, n.id + ' right of root')
    else assert.ok(n.x + n.w <= root.x, n.id + ' left of root')
    if (n.depth === 2) assert.equal(n.side, L.byId.get(n.parent!)!.side)
  }
  // Each side keeps document order top to bottom.
  for (const s of [1, -1]) {
    const ys = L.nodes.filter(n => n.depth === 1 && n.side === s).map(n => n.y)
    assert.deepEqual(ys, [...ys].sort((a, b) => a - b))
  }
  assert.ok(L.nodes.every(n => n.x >= 0 && n.y >= 0 && n.x + n.w <= L.width + 1e-6 && n.y + n.h <= L.height + 1e-6))
})

test('right layout: all to the right, document order preserved, default mode', () => {
  const doc = makeDoc([{ text: 'a', kids: 2 }, { text: 'b' }, { text: 'c', kids: 3 }])
  const L = layoutMap(doc, 'root', 'T', measure)
  assert.equal(L.mode, 'right')
  assert.deepEqual(L.nodes.map(n => n.id), ['root', 't0', 't0-0', 't0-1', 't1', 't2', 't2-0', 't2-1', 't2-2'])
  assert.ok(L.nodes.every(n => n.side === 1))
  const ys = ['t0', 't1', 't2'].map(id => L.byId.get(id)!.y)
  assert.ok(ys[0]! < ys[1]! && ys[1]! < ys[2]!)
  const root = L.byId.get('root')!
  assert.equal(root.x, 0)
  assert.deepEqual(L.byId.get('t2')!.kids, ['t2-0', 't2-1', 't2-2'])
})

test('long text is ellipsized to MAX_LINES with full text kept', () => {
  const long = 'word '.repeat(200).trim()
  const doc = makeDoc([{ text: long }, { text: 'short' }])
  const L = layoutMap(doc, 'root', 'T', measure)
  const n = L.byId.get('t0')!
  assert.equal(n.lines.length, MAX_LINES)
  assert.ok(n.clipped)
  assert.ok(n.lines[MAX_LINES - 1]!.endsWith('…'))
  assert.ok(measure(n.lines[MAX_LINES - 1]!, false) <= 260)
  assert.equal(n.full, long)
  assert.equal(L.byId.get('t1')!.clipped, false)
  const e = ellipsize(wrap('a\nb\nc', measure, false), measure, false)
  assert.equal(e.clipped, false)
  assert.equal(e.lines.length, 3)
})

test('branch index follows the depth-1 ancestor; root font larger', () => {
  const doc = makeDoc([{ text: 'a', kids: 2 }, { text: 'b', kids: 1 }, { text: 'c' }])
  for (const layout of ['right', 'both'] as const) {
    const L = layoutMap(doc, 'root', 'T', measure, { layout })
    assert.equal(L.byId.get('root')!.branch, -1)
    assert.equal(L.byId.get('t0')!.branch, 0)
    assert.equal(L.byId.get('t0-1')!.branch, 0)
    assert.equal(L.byId.get('t1')!.branch, 1)
    assert.equal(L.byId.get('t1-0')!.branch, 1)
    assert.equal(L.byId.get('t2')!.branch, 2)
    assert.equal(L.byId.get('root')!.fs, 17)
  }
})

test('collapsedOverride hides subtrees without touching the doc; done flag', () => {
  const doc = makeDoc([{ text: 'a', kids: 3 }, { text: 'b' }])
  doc.nodes.t1!.checked = true
  const before = JSON.stringify(doc)
  const L = layoutMap(doc, 'root', 'T', measure, { collapsedOverride: new Set(['t0']) })
  assert.equal(L.byId.get('t0')!.collapsed, true)
  assert.equal(L.byId.get('t0')!.hidden, 3)
  assert.equal(L.byId.has('t0-0'), false)
  assert.equal(L.byId.get('t1')!.done, true)
  assert.equal(L.byId.get('t1')!.check, true)
  assert.equal(JSON.stringify(doc), before)
})

test('svg export: options and canvas limits', () => {
  const doc = makeDoc([{ text: 'a&<b>', kids: 1 }])
  doc.nodes.t0!.collapsed = true
  const L = layoutMap(doc, 'root', 'T', measure, { layout: 'both' })
  const colors = { bg: '#111111', text: '#eeeeee', sub: '#999999', border: '#444444', accent: '#3964fe', panel: '#222222', card: '#1a1a1a', font: 'sans-serif', dark: true }
  const plain = mapToSvg(L, colors)
  const titled = mapToSvg(L, colors, { title: '标题', background: 'transparent' })
  assert.ok(plain.svg.includes('a&amp;&lt;b&gt;'))
  assert.ok(plain.svg.includes('#111111'))
  assert.ok(!titled.svg.includes('height="100%"'))
  assert.ok(titled.svg.includes('标题'))
  assert.equal(titled.height, plain.height + 44)
  const white = mapToSvg(L, colors, { background: 'white' })
  assert.ok(white.svg.includes('#1f2329'))
  assert.ok(pngFits(1000, 1000, 2))
  assert.equal(pngFits(9000, 100, 2), false)
  assert.equal(pngFits(8000, 8000, 2), false)
})

test('docMapLayout defaults to right; both only when saved', () => {
  const d = makeDoc([{ text: 'a' }])
  assert.equal(docMapLayout(d), 'right')
  assert.equal(docMapLayout({ ...d, view: { mapLayout: 'both' } } as OutlineDoc), 'both')
  assert.equal(docMapLayout({ ...d, view: { mapLayout: 'right' } } as OutlineDoc), 'right')
})

test('wrap never exceeds MAX_TEXT_W, also for a long token after a short word', () => {
  const long = 'see ' + 'x'.repeat(80) + ' end'
  const lines = wrap(long, measure, false)
  for (const l of lines) assert.ok(measure(l, false) <= MAX_TEXT_W, 'line too wide: ' + l)
  assert.equal(lines.join('').replace(/\s/g, ''), long.replace(/\s/g, ''))
})
