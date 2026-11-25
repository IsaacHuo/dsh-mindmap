import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDoc, type OutlineDoc } from '../src/shared/model.ts'
import { applyAiOps } from '../src/shared/aiOps.ts'
import { aiTip, aiViews, pendingIn, reviewMenu } from '../src/client/ai.ts'
import { nodePath, nodeQuote, nodeSessionPrompt, subtreeMarkdown } from '../src/client/nodeSession.ts'

function sample(): OutlineDoc {
  return createDoc('Plan', 1, [
    { text: 'a', children: [{ text: 'a1', children: [{ text: 'a1x', children: [] }] }, { text: 'a2', children: [] }] },
    { text: 'b', children: [] },
  ])
}
const idOf = (doc: OutlineDoc, text: string) => Object.values(doc.nodes).find(n => n.text === text)!.id
const ctx = { now: 5, sessionId: 's1' }

test('aiViews: own marks, and the subtree of a deletion is gone (also from a zoom root)', () => {
  const doc = sample()
  const r = applyAiOps(doc, [
    { op: 'delete', nodeId: idOf(doc, 'a1') },
    { op: 'edit', nodeId: idOf(doc, 'b'), text: 'B' },
  ], ctx).doc
  const v = aiViews(r)
  assert.equal(v.get(idOf(doc, 'a1')), 'deleted')
  assert.equal(v.get(idOf(doc, 'a1x')), 'gone')
  assert.equal(v.get(idOf(doc, 'b')), 'edited')
  assert.equal(v.has(idOf(doc, 'a2')), false)
  // Zoomed into a1x: it still shows as inside the deletion.
  assert.equal(aiViews(r, idOf(doc, 'a1x')).get(idOf(doc, 'a1x')), 'gone')
  assert.match(aiTip(r.nodes[idOf(doc, 'b')]!)!, /原文：b/)
  assert.equal(aiTip(r.nodes[idOf(doc, 'a2')]!), null)
})

test('reviewMenu offers node and subtree review; accepting through it removes the mark', () => {
  const doc = sample()
  const r = applyAiOps(doc, [
    { op: 'edit', nodeId: idOf(doc, 'a'), text: 'A' },
    { op: 'edit', nodeId: idOf(doc, 'a2'), text: 'A2' },
  ], ctx).doc
  assert.deepEqual(new Set(pendingIn(r, idOf(doc, 'a'))), new Set([idOf(doc, 'a'), idOf(doc, 'a2')]))
  let out: OutlineDoc | null = null
  const items = reviewMenu(r, idOf(doc, 'a'), next => { out = next })
  const labels = items.map(i => ('label' in i ? i.label : '-'))
  assert.ok(labels.includes('接受此处 AI 修改'))
  assert.ok(labels.some(l => l.startsWith('接受子树中全部 AI 修改（2）')))
  const all = items.find(i => 'label' in i && i.label.startsWith('拒绝子树'))!
  assert.ok('onSelect' in all)
  all.onSelect()
  assert.ok(out !== null)
  const d = out as OutlineDoc
  assert.equal(d.nodes[idOf(doc, 'a')]!.text, 'a')
  assert.equal(d.nodes[idOf(doc, 'a2')]!.text, 'a2')
  assert.equal(d.nodes[idOf(doc, 'a')]!.ai, undefined)
  assert.deepEqual(reviewMenu(sample(), idOf(doc, 'b'), () => {}), [])
})

test('node session prompt: path, reference, subtree and the trace rules', () => {
  const doc = sample()
  const id = idOf(doc, 'a1')
  assert.equal(nodePath(doc, id), 'Plan › a › a1')
  const p = nodeSessionPrompt(doc, id)
  assert.match(p, /Plan › a › a1/)
  assert.ok(p.includes('mindmap://' + doc.id + '/' + id))
  assert.match(p, /a1x/)
  assert.match(p, /留痕/)
  const q = nodeQuote(doc, id)
  assert.match(q.summary, /a1/)
  assert.ok(q.text.includes('mindmap://'))
})

test('subtree markdown is cut at the limit', () => {
  const doc = createDoc('Big', 1, Array.from({ length: 900 }, (_, i) => ({ text: 'line number ' + i, children: [] })))
  const full = subtreeMarkdown(doc, doc.rootId, 1_000_000)
  assert.equal(full.cut, false)
  const cut = subtreeMarkdown(doc, doc.rootId, 500)
  assert.equal(cut.cut, true)
  assert.ok(cut.text.length <= 500)
  assert.ok(nodeSessionPrompt(doc, doc.rootId).includes('已截断'))
})
