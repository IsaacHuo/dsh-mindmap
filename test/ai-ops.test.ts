import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDoc, validateDoc, type OutlineDoc } from '../src/shared/model.ts'
import { AI_LIMITS, applyAiOps, bindSession, nodeForSession, parseRef, nodeRef, pendingAi, reviewAi, unbindSession, underDeletion } from '../src/shared/aiOps.ts'

const texts = (doc: OutlineDoc, id = doc.rootId): unknown[] => doc.nodes[id]!.children.map(c => {
  const n = doc.nodes[c]!
  return n.children.length > 0 ? [n.text, texts(doc, c)] : n.text
})
function sample(): OutlineDoc {
  return createDoc('t', 1, [
    { text: 'a', children: [{ text: 'a1', children: [] }, { text: 'a2', children: [] }] },
    { text: 'b', note: 'nb', children: [] },
  ])
}
const idOf = (doc: OutlineDoc, text: string) => Object.values(doc.nodes).find(n => n.text === text)!.id
const ctx = { now: 5, sessionId: 's1' }

test('delete only marks the node; the subtree stays', () => {
  const doc = sample()
  const r = applyAiOps(doc, [{ op: 'delete', nodeId: idOf(doc, 'a') }], ctx)
  assert.deepEqual(texts(r.doc), texts(doc))
  assert.equal(r.doc.nodes[idOf(doc, 'a')]!.ai?.kind, 'deleted')
  assert.equal(r.doc.nodes[idOf(doc, 'a')]!.ai?.sessionId, 's1')
  assert.ok(underDeletion(r.doc, idOf(doc, 'a1')))
  assert.equal(validateDoc(r.doc), null)
  assert.deepEqual(r.deleted, [idOf(doc, 'a')])
})

test('add (nested) marks every new node; delete of an added node removes it', () => {
  const doc = sample()
  const r = applyAiOps(doc, [{ op: 'add', parentId: idOf(doc, 'a'), index: 1, text: 'new', children: [{ text: 'kid' }] }], ctx)
  assert.deepEqual(texts(r.doc), [['a', ['a1', ['new', ['kid']], 'a2']], 'b'])
  assert.equal(r.added.length, 2)
  for (const id of r.added) assert.equal(r.doc.nodes[id]!.ai?.kind, 'added')
  assert.equal(validateDoc(r.doc), null)
  const r2 = applyAiOps(r.doc, [{ op: 'delete', nodeId: r.added[0]! }], ctx)
  assert.deepEqual(texts(r2.doc), texts(doc))
  assert.equal(r2.removed.length, 2)
  assert.equal(validateDoc(r2.doc), null)
})

test('edit keeps the first original; editing back clears the mark', () => {
  const doc = sample()
  const b = idOf(doc, 'b')
  let r = applyAiOps(doc, [{ op: 'edit', nodeId: b, text: 'b2' }, { op: 'edit', nodeId: b, text: 'b3', note: '' }], ctx)
  assert.equal(r.doc.nodes[b]!.text, 'b3')
  assert.equal(r.doc.nodes[b]!.note, undefined)
  assert.equal(r.doc.nodes[b]!.ai?.prevText, 'b')
  assert.equal(r.doc.nodes[b]!.ai?.prevNote, 'nb')
  r = applyAiOps(r.doc, [{ op: 'edit', nodeId: b, text: 'b', note: 'nb' }], ctx)
  assert.equal(r.doc.nodes[b]!.ai, undefined)
})

test('edit of an added node keeps it added; checked edit is tracked', () => {
  const doc = sample()
  const r = applyAiOps(doc, [{ op: 'add', parentId: doc.rootId, text: 'x' }], ctx)
  const x = r.added[0]!
  const r2 = applyAiOps(r.doc, [{ op: 'edit', nodeId: x, text: 'y' }, { op: 'edit', nodeId: idOf(doc, 'a2'), checked: true }], ctx)
  assert.equal(r2.doc.nodes[x]!.ai?.kind, 'added')
  assert.equal(r2.doc.nodes[idOf(doc, 'a2')]!.checked, true)
  assert.equal(r2.doc.nodes[idOf(doc, 'a2')]!.ai?.prevChecked, null)
})

test('accept / reject for each kind', () => {
  const doc = sample()
  const a = idOf(doc, 'a'), b = idOf(doc, 'b')
  const r = applyAiOps(doc, [
    { op: 'add', parentId: doc.rootId, text: 'n' },
    { op: 'edit', nodeId: b, text: 'B' },
    { op: 'delete', nodeId: a },
  ], ctx)
  const n = r.added[0]!
  assert.deepEqual(pendingAi(r.doc).map(p => p.kind), ['deleted', 'edited', 'added'])
  const acc = reviewAi(r.doc, [n, b, a], 'accept')
  assert.deepEqual(texts(acc), ['B', 'n'])
  assert.deepEqual(pendingAi(acc), [])
  assert.equal(validateDoc(acc), null)
  const rej = reviewAi(r.doc, [n, b, a], 'reject')
  assert.deepEqual(texts(rej), texts(doc))
  assert.equal(rej.nodes[b]!.note, 'nb')
  assert.deepEqual(pendingAi(rej), [])
  assert.equal(validateDoc(rej), null)
  assert.equal(reviewAi(doc, [a], 'accept'), doc)
})

test('reject of an edited-then-deleted node restores the original text', () => {
  const doc = sample()
  const b = idOf(doc, 'b')
  const r = applyAiOps(doc, [{ op: 'edit', nodeId: b, text: 'B' }, { op: 'delete', nodeId: b }], ctx)
  assert.equal(r.doc.nodes[b]!.ai?.kind, 'deleted')
  assert.equal(reviewAi(r.doc, [b], 'reject').nodes[b]!.text, 'b')
})

test('invalid ops fail atomically with an index', () => {
  const doc = sample()
  assert.throws(() => applyAiOps(doc, [{ op: 'edit', nodeId: idOf(doc, 'b'), text: 'x' }, { op: 'delete', nodeId: 'nope00' }], ctx), /op #1/)
  assert.throws(() => applyAiOps(doc, [{ op: 'move', nodeId: idOf(doc, 'b') }], ctx), /unsupported op/)
  assert.throws(() => applyAiOps(doc, [{ op: 'delete', nodeId: doc.rootId }], ctx), /root/)
  assert.throws(() => applyAiOps(doc, [], ctx), /non-empty/)
  assert.throws(() => applyAiOps(doc, Array.from({ length: AI_LIMITS.ops + 1 }, () => ({ op: 'delete', nodeId: idOf(doc, 'b') })), ctx), /at most/)
  const del = applyAiOps(doc, [{ op: 'delete', nodeId: idOf(doc, 'a') }], ctx).doc
  assert.throws(() => applyAiOps(del, [{ op: 'add', parentId: idOf(doc, 'a1'), text: 'x' }], ctx), /pending deletion/)
  assert.throws(() => applyAiOps(del, [{ op: 'edit', nodeId: idOf(doc, 'a'), text: 'x' }], ctx), /pending deletion/)
})

test('validateDoc rejects malformed ai / sessions', () => {
  const doc = sample()
  const b = idOf(doc, 'b')
  const bad = (patch: object) => ({ ...doc, nodes: { ...doc.nodes, [b]: { ...doc.nodes[b]!, ...patch } } })
  assert.match(validateDoc(bad({ ai: { kind: 'nuked', at: 1 } }))!, /ai mark/)
  assert.match(validateDoc(bad({ ai: { kind: 'edited', at: 'x' } }))!, /ai mark/)
  assert.match(validateDoc(bad({ sessions: [{ id: '', createdAt: 1 }] }))!, /sessions/)
  assert.match(validateDoc(bad({ sessions: {} }))!, /sessions/)
  assert.equal(validateDoc(bad({ ai: { kind: 'edited', at: 1, prevText: 'b' }, sessions: [{ id: 's', createdAt: 1 }] })), null)
})

test('bind / unbind sessions and refs', () => {
  const doc = sample()
  const a = idOf(doc, 'a')
  let d = bindSession(doc, a, { id: 's1', createdAt: 1 })
  d = bindSession(d, a, { id: 's2', createdAt: 2 })
  d = bindSession(d, a, { id: 's1', title: 'again', createdAt: 3 })
  assert.deepEqual(d.nodes[a]!.sessions!.map(s => s.id), ['s1', 's2'])
  assert.equal(nodeForSession(d, 's2'), a)
  d = unbindSession(unbindSession(d, a, 's1'), a, 's2')
  assert.equal(d.nodes[a]!.sessions, undefined)
  assert.equal(unbindSession(d, a, 'zz'), d)
  assert.deepEqual(parseRef(nodeRef(doc.id, a)), { docId: doc.id, nodeId: a })
  assert.deepEqual(parseRef(nodeRef(doc.id)), { docId: doc.id })
  assert.equal(parseRef('mindmap://../etc'), null)
})
