import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDoc, toItems, type TreeItem } from '../src/shared/model.ts'
import { parseMarkdown, parsePasted, toMarkdown } from '../src/shared/markdown.ts'
import { parseOpml, toOpml } from '../src/shared/opml.ts'
import { searchDoc } from '../src/shared/search.ts'
import { History } from '../src/shared/history.ts'

const items: TreeItem[] = [
  { text: '2027 目标', children: [
    { text: '学习 **Rust**', children: [{ text: '读完《程序设计》\n第二行\n\n第四行', children: [] }] },
    { text: '健身', checked: false, children: [{ text: '跑步 <5km> & "游泳"', checked: true, children: [] }] },
  ] },
  { text: '', children: [] },
  { text: '- 不是列表', children: [{ text: '  前导空格', children: [] }, { text: '[x] 字面量\n- 续行像列表\n# 续行像标题\n\\反斜杠', children: [] }] },
]

test('markdown export → import is lossless', () => {
  const doc = createDoc('2027 个人规划', 1, items)
  const md = toMarkdown(doc)
  assert.ok(md.startsWith('# 2027 个人规划\n'))
  const parsed = parseMarkdown(md)
  assert.equal(parsed.title, '2027 个人规划')
  assert.deepEqual(parsed.items, toItems(doc, doc.nodes[doc.rootId]!.children))
})

test('markdown import: headings, ordered lists, tabs, 4-space indents, checkboxes', () => {
  const src = '# A\n\n## B\n1. one\n\t* two\n        - [x] three\nplain\n# C\n+ four'
  const p = parseMarkdown(src)
  assert.equal(p.title, undefined, 'two H1s → no title')
  assert.deepEqual(p.items, [
    { text: 'A', children: [{ text: 'B', children: [
      { text: 'one', children: [{ text: 'two', children: [{ text: 'three', checked: true, children: [] }] }] },
      { text: 'plain', children: [] },
    ] }] },
    { text: 'C', children: [{ text: 'four', children: [] }] },
  ])
})

test('paste: indented plain text nests by indentation', () => {
  assert.deepEqual(parsePasted('a\n  b\n    c\nd'), [
    { text: 'a', children: [{ text: 'b', children: [{ text: 'c', children: [] }] }] },
    { text: 'd', children: [] },
  ])
  assert.deepEqual(parsePasted('- x\n  - y'), [{ text: 'x', children: [{ text: 'y', children: [] }] }])
})

test('opml round trip keeps text, nesting, specials and checklist', () => {
  const doc = createDoc('规划 & <计划>', 1, items)
  const xml = toOpml(doc)
  const p = parseOpml(xml)
  assert.equal(p.title, '规划 & <计划>')
  assert.deepEqual(p.items, toItems(doc, doc.nodes[doc.rootId]!.children))
  assert.throws(() => parseOpml('<html></html>'))
})

test('search hits titles and node text case-insensitively', () => {
  const doc = createDoc('Plan', 1, items)
  const hits = searchDoc(doc, 'Plan', 'rust')
  assert.equal(hits.length, 1)
  assert.ok(hits[0]!.snippet.includes('Rust'))
  assert.equal(searchDoc(doc, 'Plan', 'plan')[0]!.nodeId, null)
  assert.deepEqual(searchDoc(doc, 'Plan', '  '), [])
})

test('history merges typing runs and restores selection', () => {
  const h = new History<number>()
  h.record(0, { nodeId: 'a', caret: 0 }, 'text:a', 1000)
  h.record(1, { nodeId: 'a', caret: 1 }, 'text:a', 1500)
  h.record(2, { nodeId: 'a', caret: 2 }, 'struct', 1600)
  let e = h.undo(3, null)!
  assert.equal(e.state, 2)
  e = h.undo(2, null)!
  assert.equal(e.state, 0)
  assert.equal(h.canUndo(), false)
  assert.equal(h.redo(0, null)!.state, 2)
  h.record(5, null, 'text:a', 9000)
  assert.equal(h.canRedo(), false, 'new edit clears redo')
})
