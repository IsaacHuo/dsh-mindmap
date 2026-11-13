import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { MindmapStorage, StorageError } from '../src/host/storage.ts'
import { createHandler } from '../src/host/routes.ts'
import * as ops from '../src/shared/ops.ts'
import type { OutlineDoc } from '../src/shared/model.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-mindplan-test-'))
}

test('storage: create, save with revision check, reload from disk', async () => {
  const dir = await tempDir()
  try {
    const s = new MindmapStorage(dir)
    const { doc } = await s.createDoc({ title: '2027 个人规划' })
    const edited = ops.setText(doc, doc.nodes[doc.rootId]!.children[0]!, '目标一')
    const saved = await s.saveDoc(doc.id, edited, 0)
    assert.equal(saved.revision, 1)
    await assert.rejects(s.saveDoc(doc.id, edited, 0), (e: unknown) => e instanceof StorageError && e.code === 'conflict' && e.current?.revision === 1)
    await assert.rejects(s.saveDoc(doc.id, { ...edited, nodes: {} }, 1), (e: unknown) => e instanceof StorageError && e.code === 'invalid_input')
    const fresh = new MindmapStorage(dir)
    const lib = await fresh.getLibrary()
    assert.equal(lib.docs.length, 1)
    assert.equal(lib.docs[0]!.title, '2027 个人规划')
    const back = await fresh.getDoc(doc.id)
    assert.equal(back.nodes[back.nodes[back.rootId]!.children[0]!]!.text, '目标一')
    assert.equal((await readdir(join(dir, 'backups'))).length, 1, 'daily backup written')
    assert.deepEqual((await readdir(dir)).filter(f => f.endsWith('.tmp')), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('storage: corrupt doc is quarantined, missing library row re-adopted', async () => {
  const dir = await tempDir()
  try {
    const s = new MindmapStorage(dir)
    const a = (await s.createDoc({ title: 'A' })).doc
    const b = (await s.createDoc({ title: 'B' })).doc
    await writeFile(join(dir, 'docs', a.id + '.json'), '{not json')
    await writeFile(join(dir, 'library.json'), JSON.stringify({ schema: 1, folders: [], docs: [] }))
    const s2 = new MindmapStorage(dir)
    const lib = await s2.getLibrary()
    assert.deepEqual(lib.docs.map(d => d.title), ['B'])
    assert.ok((await readdir(join(dir, 'docs'))).some(f => f.includes('.corrupt-')))
    assert.equal((await s2.getDoc(b.id)).title, 'B')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('storage: folders, favorite, rename, trash/restore/purge, search', async () => {
  const dir = await tempDir()
  try {
    const s = new MindmapStorage(dir)
    const folder = await s.createFolder('学习')
    const { doc } = await s.createDoc({ title: 'X', folderId: folder.id, items: [{ text: '读书计划', children: [] }] })
    const r = await s.patchMeta(doc.id, { title: '新标题', favorite: true })
    assert.equal(r.meta.favorite, true)
    assert.equal(r.doc?.title, '新标题')
    assert.equal(r.doc?.revision, 1)
    assert.equal((await s.search('读书'))[0]?.nodeId !== null, true)
    await s.deleteFolder(folder.id)
    assert.equal((await s.getLibrary()).docs[0]!.folderId, null)
    await assert.rejects(s.purgeDoc(doc.id))
    await s.trashDoc(doc.id)
    assert.deepEqual(await s.search('读书'), [])
    await s.restoreDoc(doc.id)
    await s.trashDoc(doc.id)
    await s.purgeDoc(doc.id)
    assert.equal((await s.getLibrary()).docs.length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('storage: backup and restore are reversible', async () => {
  const dir = await tempDir()
  try {
    const s = new MindmapStorage(dir)
    await s.createDoc({ title: 'keep' })
    const backup = await s.backupNow()
    await s.createDoc({ title: 'later' })
    const r = await s.restore({ name: backup.name })
    assert.equal(r.docs, 1)
    assert.deepEqual((await s.getLibrary()).docs.map(d => d.title), ['keep'])
    const r2 = await s.restore({ name: r.preRestore })
    assert.equal(r2.docs, 2)
    await assert.rejects(s.restore({ data: { kind: 'nope' } }))
    await assert.rejects(s.readBackup('../library.json'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('routes: envelope, content-type guard, id validation, conflict', async () => {
  const dir = await tempDir()
  const s = new MindmapStorage(dir)
  const handler = createHandler(s)
  const server: Server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}/dsh-mindplan/api`
  const post = (p: string, body: unknown, type = 'application/json') => fetch(base + p, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) })
  try {
    const created = await (await post('/docs', { markdown: '# 2027 个人规划\n\n- 学习\n  - Rust' })).json() as { ok: true; value: { doc: OutlineDoc } }
    assert.equal(created.ok, true)
    const doc = created.value.doc
    assert.equal(doc.title, '2027 个人规划')
    assert.equal(Object.keys(doc.nodes).length, 3)
    const lib = await (await fetch(base + '/library')).json() as { value: { library: { docs: unknown[] } } }
    assert.equal(lib.value.library.docs.length, 1)
    const saved = await post(`/docs/${doc.id}/save`, { doc, baseRevision: 0 })
    assert.equal(saved.status, 200)
    const conflict = await post(`/docs/${doc.id}/save`, { doc, baseRevision: 0 })
    assert.equal(conflict.status, 409)
    assert.equal(((await conflict.json()) as { error: { current: OutlineDoc } }).error.current.revision, 1)
    assert.equal((await post('/docs', { title: 'x' }, 'text/plain')).status, 400)
    assert.equal((await fetch(base + '/docs/..%2F..%2Fx')).status, 404)
    assert.equal((await fetch(base + '/backups/..%2Flibrary.json')).status, 404)
    assert.equal((await post('/docs', { opml: 'garbage' })).status, 400)
    const hits = await (await fetch(base + '/search?q=rust')).json() as { value: unknown[] }
    assert.equal(hits.value.length, 1)
    const backups = await (await fetch(base + '/backups')).json() as { value: Array<{ name: string }> }
    assert.ok(backups.value.length >= 1)
    const dl = await fetch(base + '/backups/' + backups.value[0]!.name)
    assert.equal(JSON.parse(await dl.text()).kind, 'dsh-mindplan-backup')
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
