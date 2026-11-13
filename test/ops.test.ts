import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDoc, flatten, validateDoc, type OutlineDoc } from '../src/shared/model.ts'
import * as ops from '../src/shared/ops.ts'

const texts = (doc: OutlineDoc, id = doc.rootId): unknown[] => doc.nodes[id]!.children.map(c => {
  const n = doc.nodes[c]!
  return n.children.length > 0 ? [n.text, texts(doc, c)] : n.text
})

function sample(): OutlineDoc {
  return createDoc('t', 1, [
    { text: 'a', children: [{ text: 'a1', children: [] }, { text: 'a2', children: [] }] },
    { text: 'b', children: [] },
  ])
}
const idOf = (doc: OutlineDoc, text: string) => Object.values(doc.nodes).find(n => n.text === text)!.id

test('createDoc builds a valid tree with one empty node by default', () => {
  const doc = createDoc('x', 1)
  assert.equal(validateDoc(doc), null)
  assert.deepEqual(texts(doc), [''])
})

test('splitAt: middle split, end-with-children, start insert', () => {
  let doc = sample()
  const r = ops.splitAt(doc, idOf(doc, 'b'), 0)
  assert.deepEqual(texts(r.doc), [['a', ['a1', 'a2']], '', 'b'])
  assert.equal(r.focusId, idOf(doc, 'b'))
  const r2 = ops.splitAt(doc, idOf(doc, 'a'), 1)
  assert.deepEqual(texts(r2.doc), [['a', ['', 'a1', 'a2']], 'b'])
  doc = ops.setText(doc, idOf(doc, 'b'), 'hello')
  const r3 = ops.splitAt(doc, idOf(doc, 'hello'), 2)
  assert.deepEqual(texts(r3.doc), [['a', ['a1', 'a2']], 'he', 'llo'])
  assert.equal(r3.doc.nodes[r3.focusId]!.text, 'llo')
  for (const d of [r.doc, r2.doc, r3.doc]) assert.equal(validateDoc(d), null)
})

test('indent / outdent keep order and refuse at boundaries', () => {
  const doc = sample()
  const b = idOf(doc, 'b')
  const d1 = ops.indent(doc, b)
  assert.deepEqual(texts(d1), [['a', ['a1', 'a2', 'b']]])
  assert.equal(ops.indent(doc, idOf(doc, 'a')), doc)
  const d2 = ops.outdent(d1, b)
  assert.deepEqual(texts(d2), [['a', ['a1', 'a2']], 'b'])
  assert.equal(ops.outdent(doc, b), doc)
  const a1 = idOf(doc, 'a1')
  assert.equal(ops.outdent(doc, a1, idOf(doc, 'a')), doc, 'focus floor respected')
})

test('backspaceAtStart: delete empty leaf, keep empty parent, merge into leaf sibling', () => {
  let doc = sample()
  const r = ops.splitAt(doc, idOf(doc, 'b'), 1)
  const empty = r.focusId
  const del = ops.backspaceAtStart(r.doc, empty, idOf(doc, 'b'))!
  assert.deepEqual(texts(del.doc), [['a', ['a1', 'a2']], 'b'])
  assert.equal(del.caret, 1)
  const merged = ops.backspaceAtStart(doc, idOf(doc, 'a2'), idOf(doc, 'a1'))!
  assert.deepEqual(texts(merged.doc), [['a', ['a1a2']], 'b'])
  assert.equal(merged.caret, 2)
  // Leaf after an expanded sibling merges into the visible line above (a2).
  const up = ops.backspaceAtStart(doc, idOf(doc, 'b'), idOf(doc, 'a2'))!
  assert.deepEqual(texts(up.doc), [['a', ['a1', 'a2b']]])
  assert.equal(up.focusId, idOf(doc, 'a2'))
  assert.equal(up.caret, 2)
  assert.equal(validateDoc(up.doc), null)
  // ...but a node with children never merges upwards across levels.
  const withKid = ops.insertChild(doc, idOf(doc, 'b'), 0, 'b1').doc
  assert.equal(ops.backspaceAtStart(withKid, idOf(doc, 'b'), idOf(doc, 'a2')), null, 'prev sibling expanded, node has children')
  // First child never merges into its parent.
  assert.equal(ops.backspaceAtStart(doc, idOf(doc, 'a1'), idOf(doc, 'a')), null, 'first child stays')
  doc = ops.setText(doc, idOf(doc, 'a'), '')
  const ea = Object.values(doc.nodes).find(n => n.text === '' && n.children.length === 2)!.id
  assert.equal(ops.backspaceAtStart(doc, ea, undefined), null, 'empty node with children is kept')
})

test('deleteAtEnd pulls the next sibling in', () => {
  const doc = sample()
  const r = ops.deleteAtEnd(doc, idOf(doc, 'a1'))!
  assert.deepEqual(texts(r.doc), [['a', ['a1a2']], 'b'])
  assert.equal(ops.deleteAtEnd(doc, idOf(doc, 'a')), null)
})

test('moveNode before/after/inside and cycle refusal', () => {
  const doc = sample()
  const a = idOf(doc, 'a'), b = idOf(doc, 'b'), a1 = idOf(doc, 'a1')
  assert.deepEqual(texts(ops.moveNode(doc, b, a1, 'before')), [['a', ['b', 'a1', 'a2']]])
  assert.deepEqual(texts(ops.moveNode(doc, a1, b, 'after')), [['a', ['a2']], 'b', 'a1'])
  assert.deepEqual(texts(ops.moveNode(doc, a1, b, 'inside')), [['a', ['a2']], ['b', ['a1']]])
  assert.equal(ops.moveNode(doc, a, a1, 'inside'), doc)
  assert.equal(ops.moveNode(doc, a, a, 'after'), doc)
})

test('collapse, checklist and done toggles', () => {
  let doc = sample()
  const a = idOf(doc, 'a')
  doc = ops.setCollapsed(doc, a, true)
  assert.deepEqual(flatten(doc, doc.rootId, true).map(x => doc.nodes[x.id]!.text), ['a', 'b'])
  assert.equal(ops.setCollapsed(doc, idOf(doc, 'b'), true), doc, 'leaf cannot collapse')
  doc = ops.toggleChecklist(doc, a)
  assert.equal(doc.nodes[a]!.checked, false)
  doc = ops.toggleDone(doc, a)
  assert.equal(doc.nodes[a]!.checked, true)
  doc = ops.toggleChecklist(doc, a)
  assert.equal(doc.nodes[a]!.checked, undefined)
})

test('random op sequences preserve the invariants', () => {
  let seed = 42
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  let doc = sample()
  for (let i = 0; i < 2000; i++) {
    const ids = Object.keys(doc.nodes).filter(id => id !== doc.rootId)
    if (ids.length === 0) { doc = ops.insertChild(doc, doc.rootId, 0, 'x').doc; continue }
    const id = ids[rnd(ids.length)]!
    const other = ids[rnd(ids.length)]!
    const before = Object.keys(doc.nodes).length
    switch (rnd(9)) {
      case 0: doc = ops.splitAt(doc, id, rnd(3)).doc; break
      case 1: doc = ops.indent(doc, id); break
      case 2: doc = ops.outdent(doc, id); break
      case 3: doc = ops.moveNode(doc, id, other, (['before', 'after', 'inside'] as const)[rnd(3)]!); break
      case 4: doc = ops.moveSibling(doc, id, rnd(2) === 0 ? -1 : 1); break
      case 5: { const { prev } = ops.neighbours(doc, doc.rootId, id); doc = ops.backspaceAtStart(doc, id, prev)?.doc ?? doc; break }
      case 6: if (ids.length > 30) doc = ops.deleteNode(doc, id); break
      case 7: doc = ops.setCollapsed(doc, id, rnd(2) === 0); break
      case 8: doc = ops.setText(doc, id, 'n' + i); break
    }
    const problem = validateDoc(doc)
    assert.equal(problem, null, `step ${i}: ${problem}`)
    assert.ok(Object.keys(doc.nodes).length >= 1 && Number.isFinite(before))
  }
})
