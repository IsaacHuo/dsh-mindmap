import test from 'node:test'
import assert from 'node:assert/strict'
import { countTree, folderSubtree, sortDocs } from '../src/client/docUtils.ts'
import { createDoc } from '../src/shared/model.ts'

const meta = (id: string, title: string, createdAt: number, updatedAt: number): any => ({ id, title, createdAt, updatedAt, folderId: null, favorite: false, trashed: false })

test('sortDocs: updated / title / created, input untouched', () => {
  const docs = [meta('a', '乙', 1, 30), meta('b', '甲', 3, 10), meta('c', 'A', 2, 20)]
  assert.deepEqual(sortDocs(docs, 'updated').map(d => d.id), ['a', 'c', 'b'])
  assert.deepEqual(sortDocs(docs, 'created').map(d => d.id), ['b', 'c', 'a'])
  const byTitle = sortDocs(docs, 'title').map(d => d.title)
  assert.deepEqual(byTitle, [...byTitle].sort((a, b) => a.localeCompare(b, 'zh-CN')))
  assert.ok(byTitle.indexOf('甲') < byTitle.indexOf('乙'))
  assert.deepEqual(docs.map(d => d.id), ['a', 'b', 'c'])
})

test('folderSubtree: nested descendants only, tolerates cycles', () => {
  const f = [{ id: 'r', name: 'r' }, { id: 'x', name: 'x', parentId: 'r' }, { id: 'y', name: 'y', parentId: 'x' }, { id: 'z', name: 'z' }, { id: 'p', name: 'p', parentId: 'q' }, { id: 'q', name: 'q', parentId: 'p' }] as any
  assert.deepEqual([...folderSubtree(f, 'r')].sort(), ['r', 'x', 'y'])
  assert.deepEqual([...folderSubtree(f, 'z')], ['z'])
  assert.deepEqual([...folderSubtree(f, 'p')].sort(), ['p', 'q'])
})

test('countTree: nodes, non-space chars incl. notes, todos', () => {
  const doc = createDoc('T', 1, [{ text: 'a b', children: [{ text: 'cd', note: 'e f', children: [] }] }, { text: 'x', children: [] }])
  const ids = Object.keys(doc.nodes).filter(id => id !== doc.rootId)
  for (const id of ids) if (doc.nodes[id]!.text === 'x') (doc.nodes[id] as any).checked = true
  for (const id of ids) if (doc.nodes[id]!.text === 'cd') (doc.nodes[id] as any).checked = false
  const c = countTree(doc, doc.rootId)
  assert.equal(c.nodes, 3)
  assert.equal(c.chars, 2 + 2 + 2 + 1)
  assert.deepEqual([c.todo, c.done], [2, 1])
})
