import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDoc, validateDoc, type OutlineDoc } from '../src/shared/model.ts'
import { mergeDocs } from '../src/shared/merge.ts'

function fixture(): { base: OutlineDoc; id: (text: string) => string } {
  const base = createDoc('T', 1000, [
    { text: 'a', children: [{ text: 'a1', children: [] }, { text: 'a2', children: [] }] },
    { text: 'b', children: [] },
    { text: 'c', children: [] },
  ])
  const id = (text: string): string => Object.values(base.nodes).find(n => n.text === text)!.id
  return { base, id }
}
const clone = (d: OutlineDoc): OutlineDoc => structuredClone(d)
const texts = (d: OutlineDoc, p: string): string[] => d.nodes[p]!.children.map(k => d.nodes[k]!.text)

test('independent field edits from both sides are combined', () => {
  const { base, id } = fixture()
  const mine = clone(base); mine.nodes[id('a')]!.text = 'A'
  const theirs = clone(base); theirs.nodes[id('b')]!.text = 'B'; theirs.nodes[id('b')]!.ai = { kind: 'edited', at: 2, prevText: 'b' }; theirs.revision++
  const r = mergeDocs(base, mine, theirs)
  assert.equal(validateDoc(r.doc), null)
  assert.deepEqual(texts(r.doc, r.doc.rootId), ['A', 'B', 'c'])
  assert.equal(r.doc.nodes[id('b')]!.ai?.kind, 'edited')
  assert.equal(r.doc.revision, theirs.revision)
  assert.equal(r.conflicts, 0)
})

test('same field changed on both sides: mine wins, counted as conflict', () => {
  const { base, id } = fixture()
  const mine = clone(base); mine.nodes[id('a')]!.text = 'mine'
  const theirs = clone(base); theirs.nodes[id('a')]!.text = 'theirs'
  const r = mergeDocs(base, mine, theirs)
  assert.equal(r.doc.nodes[id('a')]!.text, 'mine')
  assert.equal(r.conflicts, 1)
})

test('additions on both sides keep their relative position', () => {
  const { base, id } = fixture()
  const mine = clone(base)
  mine.nodes['mine-new'] = { id: 'mine-new', text: 'm', children: [] }
  mine.nodes[mine.rootId]!.children.splice(1, 0, 'mine-new') // after a
  const theirs = clone(base)
  theirs.nodes['their-new'] = { id: 'their-new', text: 't', children: [], ai: { kind: 'added', at: 2 } }
  theirs.nodes[theirs.rootId]!.children.splice(2, 0, 'their-new') // after b
  theirs.nodes[id('a1')]!.children.push('their-kid')
  theirs.nodes['their-kid'] = { id: 'their-kid', text: 'k', children: [] }
  const r = mergeDocs(base, mine, theirs)
  assert.equal(validateDoc(r.doc), null)
  assert.deepEqual(texts(r.doc, r.doc.rootId), ['a', 'm', 'b', 't', 'c'])
  assert.deepEqual(texts(r.doc, id('a1')), ['k'])
})

test('deletions: unchanged nodes go, changed nodes and needed parents stay', () => {
  const { base, id } = fixture()
  const mine = clone(base)
  // mine deletes c and the whole a subtree
  mine.nodes[mine.rootId]!.children = [id('b')]
  for (const t of ['a', 'a1', 'a2', 'c']) delete mine.nodes[id(t)]
  const theirs = clone(base)
  theirs.nodes[id('a2')]!.children.push('t-kid') // theirs adds under a2
  theirs.nodes['t-kid'] = { id: 't-kid', text: 'kid', children: [] }
  const r = mergeDocs(base, mine, theirs)
  assert.equal(validateDoc(r.doc), null)
  assert.deepEqual(texts(r.doc, r.doc.rootId), ['a', 'b'])
  assert.deepEqual(texts(r.doc, id('a')), ['a2'])
  assert.deepEqual(texts(r.doc, id('a2')), ['kid'])
  assert.equal(r.doc.nodes[id('c')], undefined)
  assert.equal(r.doc.nodes[id('a1')], undefined)
})

test('moves: mine wins; a move cycle is broken without losing nodes', () => {
  const { base, id } = fixture()
  const mine = clone(base) // move b under a
  mine.nodes[mine.rootId]!.children = [id('a'), id('c')]
  mine.nodes[id('a')]!.children.push(id('b'))
  const theirs = clone(base) // move a under b
  theirs.nodes[theirs.rootId]!.children = [id('b'), id('c')]
  theirs.nodes[id('b')]!.children.push(id('a'))
  const r = mergeDocs(base, mine, theirs)
  assert.equal(validateDoc(r.doc), null)
  assert.equal(Object.keys(r.doc.nodes).length, Object.keys(base.nodes).length)
  const reach = new Set<string>()
  const st = [r.doc.rootId]
  while (st.length > 0) { const n = st.pop()!; reach.add(n); st.push(...r.doc.nodes[n]!.children) }
  assert.equal(reach.size, Object.keys(base.nodes).length)
})
