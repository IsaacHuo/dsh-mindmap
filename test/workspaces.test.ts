import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DocMeta, Library } from '../src/shared/model.ts'
import { MindmapStorage } from '../src/host/storage.ts'
import { groupByWorkspace, migrationPatches, toWorkspaces, UNASSIGNED, workspaceLabel } from '../src/client/workspaces.ts'

const meta = (id: string, extra: Partial<DocMeta> = {}): DocMeta => ({ id, title: id, createdAt: 1, updatedAt: 1, folderId: null, favorite: false, ...extra } as DocMeta)

test('toWorkspaces normalises the DSH snapshot', () => {
  const ws = toWorkspaces({ phase: 'ready', items: [
    { workspaceId: 'w1', title: 'Alpha', path: 'C:/p/alpha', sessionIds: [] },
    { workspaceId: 'w2', path: 'C:/p/beta/' },
    { workspaceId: 'w1', title: 'dup' },
    { title: 'no id' },
  ] })
  assert.deepEqual(ws, [{ id: 'w1', name: 'Alpha', cwd: 'C:/p/alpha' }, { id: 'w2', name: 'beta', cwd: 'C:/p/beta/' }])
  assert.deepEqual(toWorkspaces(null), [])
})

test('groupByWorkspace: known list, unknown ids and 未归类', () => {
  const known = [{ id: 'w1', name: 'Alpha' }, { id: 'w2', name: 'Beta' }]
  const docs = [meta('a', { workspaceId: 'w1' }), meta('b', { workspaceId: 'gone' }), meta('c'), meta('d', { workspaceId: null })]
  const g = groupByWorkspace(docs, known)
  assert.deepEqual(g.map(x => [x.id, x.docs.map(d => d.id)]), [['w1', ['a']], ['w2', []], [null, ['b', 'c', 'd']]])
  // Without the live list stored names are trusted.
  const g2 = groupByWorkspace([meta('b', { workspaceId: 'gone', workspaceName: 'Old' })], null)
  assert.deepEqual(g2.map(x => x.name), ['Old', UNASSIGNED])
  assert.equal(workspaceLabel(docs[1], known), UNASSIGNED)
  assert.equal(workspaceLabel(meta('x', { workspaceId: 'w2' }), known), 'Beta')
})

test('migrationPatches maps folders to same-named workspaces once', () => {
  const lib = {
    folders: [{ id: 'f1', name: 'alpha ', parentId: null }, { id: 'f2', name: 'child', parentId: 'f1' }, { id: 'f3', name: 'misc', parentId: null }],
    docs: [meta('a', { folderId: 'f2' }), meta('b', { folderId: 'f3' }), meta('c'), meta('d', { folderId: 'f1', workspaceId: null })],
  } as unknown as Library
  const p = migrationPatches(lib, [{ id: 'w1', name: 'Alpha' }])
  assert.deepEqual(p, [
    { id: 'a', workspaceId: 'w1', workspaceName: 'Alpha' },
    { id: 'b', workspaceId: null },
    { id: 'c', workspaceId: null },
  ])
})

test('storage keeps workspace assignment across restarts and validates ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mindmap-ws-'))
  try {
    const s = new MindmapStorage(dir, () => 1000)
    const { meta: m } = await s.createDoc({ title: 'x', workspaceId: 'ws-1', workspaceName: ' Proj ' })
    assert.equal(m.workspaceId, 'ws-1')
    assert.equal(m.workspaceName, 'Proj')
    const { meta: n } = await s.createDoc({ title: 'y' })
    assert.equal(n.workspaceId, null)
    await assert.rejects(s.patchMeta(n.id, { workspaceId: 'bad id with spaces' }), /工作区 id 无效/)
    await s.patchMeta(m.id, { workspaceId: null })
    const lib = await new MindmapStorage(dir, () => 2000).getLibrary()
    const back = lib.docs.find(d => d.id === m.id)!
    assert.equal(back.workspaceId, null)
    assert.equal(back.workspaceName, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
