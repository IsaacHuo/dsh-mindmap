import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDoc, flatten, itemsDepth, toItems, validateDoc, type OutlineDoc, type TreeItem } from '../src/shared/model.ts'
import { parseMarkdown, toMarkdown } from '../src/shared/markdown.ts'
import { parseOpml, toOpml } from '../src/shared/opml.ts'
import { History } from '../src/shared/history.ts'
import * as ops from '../src/shared/ops.ts'

const texts = (doc: OutlineDoc, id = doc.rootId): unknown[] => doc.nodes[id]!.children.map(c => {
  const n = doc.nodes[c]!
  return n.children.length > 0 ? [n.text, texts(doc, c)] : n.text
})
const idOf = (doc: OutlineDoc, text: string) => Object.values(doc.nodes).find(n => n.text === text)!.id
const tree = (...items: TreeItem[]) => createDoc('t', 1, items)
const leaf = (text: string): TreeItem => ({ text, children: [] })

const noted: TreeItem[] = [
  { text: '计划', note: '第一行备注\n\n- 像列表\n# 像标题\n```js\nx\n```', children: [
    { text: '子项\n续行', checked: true, note: 'a > b & "c"', children: [] },
  ] },
  { text: '无备注', children: [] },
]

test('OPML: ">" inside attribute values and _note survive import', () => {
  const xml = '<opml version="2.0"><body><outline text="a > b" _note="n1&#10;n2"><outline text=\'x > y\'/></outline></body></opml>'
  const { items } = parseOpml(xml)
  assert.deepEqual(items, [{ text: 'a > b', note: 'n1\nn2', children: [{ text: 'x > y', children: [] }] }])
})

test('OPML and Markdown round-trip notes', () => {
  const doc = createDoc('备注', 1, noted)
  assert.equal(validateDoc(doc), null)
  assert.deepEqual(parseOpml(toOpml(doc)).items, noted)
  const md = parseMarkdown(toMarkdown(doc))
  assert.equal(md.title, '备注')
  assert.deepEqual(md.items, noted)
})

test('Markdown: fenced code stays a note and does not count as a heading', () => {
  const src = '# T\n\n- a\n\n```\n# not heading\n- not item\n```\n- b\n'
  const r = parseMarkdown(src)
  assert.equal(r.title, 'T')
  assert.deepEqual(r.items, [{ text: 'a', note: '```\n# not heading\n- not item\n```', children: [] }, leaf('b')])
})

test('Markdown: paragraphs under a heading become its note', () => {
  const r = parseMarkdown('## A\npara one\n\npara two\n## B\n- x\n')
  assert.deepEqual(r.items, [{ text: 'A', note: 'para one\n\npara two', children: [] }, { text: 'B', children: [leaf('x')] }])
})

test('deep trees do not overflow the stack', () => {
  const top: TreeItem = leaf('0')
  let cur = top
  for (let i = 1; i < 20000; i++) { const next = leaf(String(i)); cur.children.push(next); cur = next }
  assert.equal(itemsDepth([top]), 20000)
  const doc = createDoc('deep', 1, [top])
  assert.equal(validateDoc(doc), null)
  assert.equal(flatten(doc, doc.rootId, true).length, 20000)
  assert.equal(itemsDepth(toItems(doc, doc.nodes[doc.rootId]!.children)), 20000)
})

test('pasteItems splits at the caret and replaces the selection', () => {
  const doc = tree(leaf('hello world'))
  const id = idOf(doc, 'hello world')
  const r = ops.pasteItems(doc, id, 5, 5, [{ text: 'X', children: [leaf('k')] }, leaf('Y')])
  assert.deepEqual(texts(r.doc), [['helloX', ['k']], 'Y world'])
  assert.equal(r.caret, 1)
  assert.equal(r.focusId, idOf(r.doc, 'Y world'))
  assert.equal(validateDoc(r.doc), null)
  const one = ops.pasteItems(doc, id, 0, 5, [leaf('Z')])
  assert.deepEqual(texts(one.doc), ['Z world'])
  assert.equal(one.focusId, id)
  assert.equal(one.caret, 1)
})

test('batch ops: indent/outdent/delete/move many', () => {
  const doc = tree({ text: 'a', children: [leaf('a1'), leaf('a2')] }, leaf('b'), leaf('c'))
  const sel = [idOf(doc, 'b'), idOf(doc, 'c')]
  const ind = ops.indentMany(doc, sel)
  assert.deepEqual(texts(ind), [['a', ['a1', 'a2', 'b', 'c']]])
  assert.deepEqual(texts(ops.outdentMany(ind, sel)), [['a', ['a1', 'a2']], 'b', 'c'])
  assert.deepEqual(texts(ops.deleteMany(doc, [idOf(doc, 'a'), idOf(doc, 'a1'), idOf(doc, 'b')])), ['c'])
  assert.deepEqual(texts(ops.moveMany(doc, sel, -1)), ['b', 'c', ['a', ['a1', 'a2']]])
  assert.equal(ops.moveMany(doc, sel, 1), doc)
  assert.equal(validateDoc(ind), null)
})

test('Enter on an empty last child outdents', () => {
  const doc = tree({ text: 'a', children: [leaf('a1'), leaf('a2')] }, leaf('b'))
  const r1 = ops.splitAt(doc, idOf(doc, 'a2'), 2)
  const r2 = ops.splitAt(r1.doc, r1.focusId, 0)
  assert.equal(r2.focusId, r1.focusId)
  assert.deepEqual(texts(r2.doc), [['a', ['a1', 'a2']], '', 'b'])
})

test('moveSibling crosses parent boundaries but not the floor', () => {
  const doc = tree({ text: 'a', children: [leaf('a1'), leaf('a2')] }, { text: 'b', children: [leaf('b1')] })
  assert.deepEqual(texts(ops.moveSibling(doc, idOf(doc, 'b1'), -1)), [['a', ['a1', 'a2', 'b1']], 'b'])
  assert.deepEqual(texts(ops.moveSibling(doc, idOf(doc, 'a2'), 1)), [['a', ['a1']], ['b', ['a2', 'b1']]])
  assert.equal(ops.moveSibling(doc, idOf(doc, 'a2'), 1, idOf(doc, 'a')), doc)
})

test('setNote / setView', () => {
  const doc = tree(leaf('x'))
  const id = idOf(doc, 'x')
  const n = ops.setNote(doc, id, 'memo')
  assert.equal(n.nodes[id]!.note, 'memo')
  assert.equal(ops.setNote(n, id, 'memo'), n)
  assert.equal('note' in ops.setNote(n, id, '').nodes[id]!, false)
  const v = ops.setView(doc, { mapLayout: 'right' })
  assert.deepEqual(v.view, { mapLayout: 'right' })
  assert.equal(ops.setView(v, { mapLayout: 'right' }), v)
})

test('history: typing runs merge for at most MAX_RUN_MS', () => {
  const h = new History<number>()
  const at = [0, 500, 1000, 1500, 2000, 2500]
  assert.deepEqual(at.map(t => h.record(t, null, 'k', t)), [true, false, false, false, false, false])
  assert.equal(h.record(3100, null, 'k', 3100), true)
})
