import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDoc, type OutlineDoc, type TreeItem } from '../src/shared/model.ts'
import * as ops from '../src/shared/ops.ts'
import {
  collapsedAncestors, filterRows, findMatches, hasTag, NODES_MIME, offsetAtX, onFirstLine, onLastLine,
  rangeIds, replaceAll, replaceMatch, tagsOf, toggleMark, type CaretBox,
} from '../src/client/outline/helpers.ts'
import { clipboardItems, parseNodesJson, selectionItems, selectionMarkdown } from '../src/client/outline/clipboard.ts'

const leaf = (text: string, note?: string): TreeItem => (note === undefined ? { text, children: [] } : { text, note, children: [] })
const node = (text: string, ...children: TreeItem[]): TreeItem => ({ text, children })
const idOf = (doc: OutlineDoc, text: string): string => Object.values(doc.nodes).find(n => n.text === text)!.id
const textsOf = (doc: OutlineDoc, rows: Array<{ id: string }>): string[] => rows.map(r => doc.nodes[r.id]!.text)

test('toggleMark wraps and unwraps', () => {
  assert.deepEqual(toggleMark('abc', 0, 3, '**'), { text: '**abc**', start: 2, end: 5 })
  assert.deepEqual(toggleMark('**abc**', 2, 5, '**'), { text: 'abc', start: 0, end: 3 })
  assert.deepEqual(toggleMark('**abc**', 0, 7, '**'), { text: 'abc', start: 0, end: 3 })
  assert.deepEqual(toggleMark('ab', 1, 1, '*'), { text: 'a**b', start: 2, end: 2 })
  assert.deepEqual(toggleMark('x ~~y~~ z', 4, 5, '~~'), { text: 'x y z', start: 2, end: 3 })
  assert.deepEqual(toggleMark('code', 0, 4, '\u0060'), { text: '\u0060code\u0060', start: 1, end: 5 })
})

test('toggleMark: italic inside bold wraps, does not unwrap the bold', () => {
  assert.deepEqual(toggleMark('**abc**', 2, 5, '*'), { text: '***abc***', start: 3, end: 6 })
  assert.deepEqual(toggleMark('***abc***', 3, 6, '*'), { text: '**abc**', start: 2, end: 5 })
})

// 'abcdef' wrapped after 'abc': offsets 0..2 on line 1, 3..6 on line 2.
const boxes: CaretBox[] = [
  { top: 0, left: 0 }, { top: 0, left: 10 }, { top: 0, left: 20 },
  { top: 24, left: 0 }, { top: 24, left: 10 }, { top: 24, left: 20 }, { top: 24, left: 30 },
]

test('onFirstLine / onLastLine on visual lines', () => {
  assert.equal(onFirstLine(boxes, 0), true)
  assert.equal(onFirstLine(boxes, 2), true)
  assert.equal(onFirstLine(boxes, 3), false)
  assert.equal(onLastLine(boxes, 2), false)
  assert.equal(onLastLine(boxes, 3), true)
  assert.equal(onLastLine(boxes, 6), true)
  // Single line: both.
  const one: CaretBox[] = [{ top: 0, left: 0 }, { top: 0.5, left: 8 }]
  assert.equal(onFirstLine(one, 1), true)
  assert.equal(onLastLine(one, 0), true)
})

test('offsetAtX keeps the column on the target line', () => {
  assert.equal(offsetAtX(boxes, 'last', 12), 4)
  assert.equal(offsetAtX(boxes, 'last', 999), 6)
  assert.equal(offsetAtX(boxes, 'first', 100), 2)
  assert.equal(offsetAtX(boxes, 'first', -5), 0)
  assert.equal(offsetAtX([], 'first', 5), 0)
})

test('tagsOf / hasTag', () => {
  assert.deepEqual(tagsOf('a #x b#y #z 中文 #标签'), ['#x', '#z', '#标签'])
  assert.deepEqual(tagsOf('#start'), ['#start'])
  assert.equal(hasTag('foo', 'note #Work', '#work'), true)
  assert.equal(hasTag('foo #work', undefined, '#WORK'), true)
  assert.equal(hasTag('foo#work', undefined, '#work'), false)
  assert.equal(hasTag('foo', undefined, '#work'), false)
})

test('filterRows keeps matches, their ancestors and kept ids', () => {
  const doc = createDoc('t', 1, [node('A', leaf('A1 #t'), leaf('A2')), leaf('B'), node('C #t', leaf('C1'))])
  const collapsed = ops.setCollapsed(doc, idOf(doc, 'A'), true)
  const rows = filterRows(collapsed, collapsed.rootId, '#t')
  assert.deepEqual(textsOf(collapsed, rows), ['A', 'A1 #t', 'C #t'])
  assert.deepEqual(rows.map(r => r.depth), [0, 1, 0])
  const kept = filterRows(collapsed, collapsed.rootId, '#T', [idOf(doc, 'B')])
  assert.deepEqual(textsOf(collapsed, kept), ['A', 'A1 #t', 'B', 'C #t'])
  assert.deepEqual(filterRows(doc, doc.rootId, '#none'), [])
})

test('findMatches covers text and notes (collapsed included), case toggle', () => {
  const doc = createDoc('t', 1, [node('foo Foo', leaf('x', 'a FOO note'))])
  const parent = idOf(doc, 'foo Foo')
  const d = ops.setCollapsed(doc, parent, true)
  const all = findMatches(d, d.rootId, 'foo', false)
  assert.equal(all.length, 3)
  assert.deepEqual(all.map(m => [m.field, m.start, m.end]), [['text', 0, 3], ['text', 4, 7], ['note', 2, 5]])
  assert.equal(findMatches(d, d.rootId, 'foo', true).length, 1)
  assert.equal(findMatches(d, d.rootId, '', false).length, 0)
  assert.equal(findMatches(d, d.rootId, 'a.b', false).length, 0)
})

test('replaceAll produces one new doc; replaceMatch is stale-safe', () => {
  const doc = createDoc('t', 1, [leaf('foo Foo'), leaf('x', 'foo note')])
  const ms = findMatches(doc, doc.rootId, 'foo', false)
  const next = replaceAll(doc, ms, 'bar')
  assert.notEqual(next, doc)
  assert.equal(next.nodes[idOf(doc, 'foo Foo')]!.text, 'bar bar')
  assert.equal(next.nodes[idOf(doc, 'x')]!.note, 'bar note')
  assert.equal(doc.nodes[idOf(doc, 'foo Foo')]!.text, 'foo Foo', 'input untouched')
  const one = replaceMatch(doc, ms[1]!, 'X')
  assert.equal(one.nodes[idOf(doc, 'foo Foo')]!.text, 'foo X')
  assert.equal(replaceMatch(doc, { id: idOf(doc, 'x'), field: 'text', start: 5, end: 9 }, 'y'), doc)
  assert.equal(replaceMatch(doc, { id: 'missing', field: 'text', start: 0, end: 1 }, 'y'), doc)
})

test('collapsedAncestors lists collapsed ancestors under the root only', () => {
  let doc = createDoc('t', 1, [node('A', node('A1', leaf('A11')))])
  const a = idOf(doc, 'A')
  const a1 = idOf(doc, 'A1')
  const a11 = idOf(doc, 'A11')
  assert.deepEqual(collapsedAncestors(doc, doc.rootId, a11), [])
  doc = ops.setCollapsed(ops.setCollapsed(doc, a, true), a1, true)
  assert.deepEqual(collapsedAncestors(doc, doc.rootId, a11), [a1, a])
  assert.deepEqual(collapsedAncestors(doc, a, a11), [a1], 'zoom root excluded')
})

test('rangeIds', () => {
  const o = ['a', 'b', 'c', 'd']
  assert.deepEqual(rangeIds(o, 'c', 'a'), ['a', 'b', 'c'])
  assert.deepEqual(rangeIds(o, 'b', 'd'), ['b', 'c', 'd'])
  assert.deepEqual(rangeIds(o, 'b', 'b'), ['b'])
  assert.deepEqual(rangeIds(o, 'zz', 'b'), ['b'])
  assert.deepEqual(rangeIds(o, 'a', 'zz'), [])
})

test('clipboard: selection → Markdown + items, payload → items', () => {
  const doc = createDoc('t', 1, [node('A', leaf('A1', 'n1')), leaf('B'), leaf('C')])
  const ids = [idOf(doc, 'A'), idOf(doc, 'A1'), idOf(doc, 'B')]
  assert.equal(selectionMarkdown(doc, ids), '- A\n  - A1\n    > n1\n- B\n')
  const items = selectionItems(doc, ids)
  assert.deepEqual(items, [node('A', leaf('A1', 'n1')), leaf('B')])
  const json = JSON.stringify(items)
  assert.deepEqual(parseNodesJson(json), items)
  assert.equal(parseNodesJson('[]'), null)
  assert.equal(parseNodesJson('{"text":"x"}'), null)
  assert.equal(parseNodesJson('[{"text":1}]'), null)
  assert.equal(parseNodesJson('not json'), null)
  const get = (map: Record<string, string>) => (type: string): string => map[type] ?? ''
  assert.deepEqual(clipboardItems(get({ [NODES_MIME]: json, 'text/plain': 'ignored' }), true), items)
  assert.equal(clipboardItems(get({ 'text/plain': 'one line' }), true), null)
  assert.deepEqual(clipboardItems(get({ 'text/plain': 'one line' }), false), [leaf('one line')])
  assert.deepEqual(clipboardItems(get({ 'text/plain': '- a\r\n  - b\r\n' }), true), [node('a', leaf('b'))])
  assert.equal(clipboardItems(get({ 'text/plain': '  ' }), false), null)
})

test('pasting selection items round-trips through pasteItems', () => {
  const src = createDoc('t', 1, [node('A', leaf('A1')), leaf('B')])
  const items = selectionItems(src, [idOf(src, 'A'), idOf(src, 'B')])
  const dst = createDoc('t', 1, [leaf('xy')])
  const r = ops.pasteItems(dst, idOf(dst, 'xy'), 1, 1, items)
  const top = r.doc.nodes[r.doc.rootId]!.children.map(id => r.doc.nodes[id]!.text)
  assert.deepEqual(top, ['xA', 'By'])
  assert.equal(r.doc.nodes[r.focusId]!.text, 'By')
  assert.equal(r.caret, 1)
})
