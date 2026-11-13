import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request, type Server } from 'node:http'
import { MindmapStorage, StorageError, BACKUP_KEEP, TRASH_RETENTION_MS, backupKind } from '../src/host/storage.ts'
import { createHandler } from '../src/host/routes.ts'
import { createDoc, type TreeItem } from '../src/shared/model.ts'

const tempDir = () => mkdtemp(join(tmpdir(), 'dsh-mindmap-v02-'))

test('backupKind classifies names', () => {
  assert.equal(backupKind('mindmap-20261113.json'), 'daily')
  assert.equal(backupKind('mindmap-20261113-101010.json'), 'manual')
  assert.equal(backupKind('mindmap-20261113-101010-pre-restore.json'), 'pre-restore')
  assert.equal(backupKind('mindmap-20261113-101010-purge.json'), 'purge')
})

test('manual backups are pruned per kind and never collide', async () => {
  const dir = await tempDir()
  try {
    const t = Date.UTC(2026, 10, 13, 4)
    const s = new MindmapStorage(dir, () => t)
    await s.createDoc({ title: 'a' })
    for (let i = 0; i < BACKUP_KEEP.manual + 3; i++) await s.backupNow()
    const list = await s.listBackups()
    assert.equal(list.filter(b => b.kind === 'manual').length, BACKUP_KEEP.manual)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('purge backups coalesce within a minute; emptyTrash', async () => {
  const dir = await tempDir()
  try {
    let t = Date.UTC(2026, 10, 13, 4)
    const s = new MindmapStorage(dir, () => t)
    const ids = [] as string[]
    for (const title of ['a', 'b', 'c', 'd']) { const { doc } = await s.createDoc({ title }); ids.push(doc.id); await s.trashDoc(doc.id) }
    await s.purgeDoc(ids[0]!)
    await s.purgeDoc(ids[1]!)
    const purgeCount = async () => (await s.listBackups()).filter(b => b.kind === 'purge').length
    assert.equal(await purgeCount(), 1)
    t += 2 * 60 * 1000
    assert.deepEqual(await s.emptyTrash(), { purged: 2 })
    assert.equal(await purgeCount(), 2)
    assert.equal((await s.getLibrary()).docs.length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('long-trashed documents are purged at startup after a backup', async () => {
  const dir = await tempDir()
  try {
    const t = Date.UTC(2026, 10, 1, 4)
    const s = new MindmapStorage(dir, () => t)
    const { doc } = await s.createDoc({ title: 'old' })
    await s.createDoc({ title: 'keep' })
    await s.trashDoc(doc.id)
    const later = new MindmapStorage(dir, () => t + TRASH_RETENTION_MS + 1000)
    assert.deepEqual((await later.getLibrary()).docs.map(d => d.title), ['keep'])
    assert.ok((await later.listBackups()).some(b => b.kind === 'purge'))
    assert.ok(!(await readdir(join(dir, 'docs'))).includes(doc.id + '.json'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('interrupted restore: staging present rolls back, swapped completes', async () => {
  const dir = await tempDir()
  try {
    const s = new MindmapStorage(dir)
    await s.createDoc({ title: 'A' })
    const b = createDoc('B', Date.now())
    const lib = { schema: 1, folders: [], docs: [{ id: b.id, title: 'B', folderId: null, favorite: false, createdAt: b.createdAt, updatedAt: b.updatedAt }] }
    // Case 1: crash before the directory swap.
    await mkdir(join(dir, 'docs.new'))
    await writeFile(join(dir, 'docs.new', b.id + '.json'), JSON.stringify(b))
    await writeFile(join(dir, 'restore.pending.json'), JSON.stringify(lib))
    const s1 = new MindmapStorage(dir)
    assert.deepEqual((await s1.getLibrary()).docs.map(d => d.title), ['A'])
    assert.equal((await s1.takeWarnings()).length, 1)
    assert.deepEqual(await s1.takeWarnings(), [])
    assert.ok(!(await readdir(dir)).includes('docs.new'))
    // Case 2: crash after the swap, before library.json was written.
    await mkdir(join(dir, 'docs.new'))
    await writeFile(join(dir, 'docs.new', b.id + '.json'), JSON.stringify(b))
    await writeFile(join(dir, 'restore.pending.json'), JSON.stringify(lib))
    await rename(join(dir, 'docs'), join(dir, 'docs.old'))
    await rename(join(dir, 'docs.new'), join(dir, 'docs'))
    const s2 = new MindmapStorage(dir)
    assert.deepEqual((await s2.getLibrary()).docs.map(d => d.title), ['B'])
    assert.equal((await s2.getDoc(b.id)).title, 'B')
    const rest = await readdir(dir)
    assert.ok(!rest.includes('docs.old') && !rest.includes('restore.pending.json'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('restore swaps atomically and keeps a pre-restore backup', async () => {
  const dir = await tempDir()
  try {
    const s = new MindmapStorage(dir)
    await s.createDoc({ title: 'one' })
    const backup = await s.backupNow()
    await s.createDoc({ title: 'two' })
    const r = await s.restore({ name: backup.name })
    assert.equal(r.docs, 1)
    assert.equal(backupKind(r.preRestore), 'pre-restore')
    assert.deepEqual((await new MindmapStorage(dir).getLibrary()).docs.map(d => d.title), ['one'])
    const rest = await readdir(dir)
    assert.ok(!rest.includes('docs.new') && !rest.includes('docs.old') && !rest.includes('restore.pending.json'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('nested folders: move refuses cycles, delete lifts contents one level', async () => {
  const dir = await tempDir()
  try {
    const s = new MindmapStorage(dir)
    const a = await s.createFolder('A')
    const b = await s.createFolder('B', a.id)
    const c = await s.createFolder('C', b.id)
    const { doc } = await s.createDoc({ title: 'x', folderId: b.id })
    await assert.rejects(s.moveFolder(a.id, c.id), (e: unknown) => e instanceof StorageError && e.code === 'invalid_input')
    await s.deleteFolder(b.id)
    const lib = await s.getLibrary()
    assert.equal(lib.folders.find(f => f.id === c.id)!.parentId, a.id)
    assert.equal(lib.docs.find(d => d.id === doc.id)!.folderId, a.id)
    assert.equal((await new MindmapStorage(dir).getLibrary()).folders.find(f => f.id === c.id)!.parentId, a.id)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('import deeper than the limit is refused; search covers notes', async () => {
  const dir = await tempDir()
  try {
    const s = new MindmapStorage(dir)
    let deep: TreeItem = { text: 'leaf', children: [] }
    for (let i = 0; i < 250; i++) deep = { text: 'n' + i, children: [deep] }
    await assert.rejects(s.createDoc({ items: [deep] }), (e: unknown) => e instanceof StorageError && e.code === 'invalid_input')
    await s.createDoc({ title: 'N', items: [{ text: 'item', note: '隐藏的备注关键词', children: [] }] })
    const hits = await s.search('备注关键词')
    assert.equal(hits.length, 1)
    assert.notEqual(hits[0]!.nodeId, null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

function raw(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers ?? {} }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c as Buffer))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

test('routes: host/origin guard, body limits, copy, trash/empty, quarantine, warnings once', async () => {
  const dir = await tempDir()
  const s = new MindmapStorage(dir)
  const handler = createHandler(s)
  const server: Server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const P = '/dsh-mindmap/api'
  const json = { 'content-type': 'application/json' }
  const self = '127.0.0.1:' + port
  try {
    assert.equal((await raw(port, P + '/library', { headers: { host: 'evil.example:' + port } })).status, 403)
    assert.equal((await raw(port, P + '/library', { headers: { host: self, origin: 'http://evil.example' } })).status, 403)
    assert.equal((await raw(port, P + '/library', { headers: { host: self, origin: 'http://' + self } })).status, 200)
    assert.equal((await raw(port, P + '/library', { headers: { host: 'localhost:' + port } })).status, 200)
    const big = JSON.stringify({ name: 'x'.repeat(1100 * 1024) })
    assert.equal((await raw(port, P + '/folders', { method: 'POST', headers: { ...json, host: self }, body: big })).status, 413)
    const created = JSON.parse((await raw(port, P + '/docs', { method: 'POST', headers: { ...json, host: self }, body: JSON.stringify({ markdown: '# T\n\n- a\n  - b' }) })).text)
    const doc = created.value.doc
    const copy = JSON.parse((await raw(port, P + '/docs', { method: 'POST', headers: { ...json, host: self }, body: JSON.stringify({ copy: doc, title: 'T 副本' }) })).text)
    assert.equal(copy.value.doc.title, 'T 副本')
    assert.notEqual(copy.value.doc.id, doc.id)
    assert.equal(Object.keys(copy.value.doc.nodes).length, 3)
    await raw(port, P + '/docs/' + doc.id + '/trash', { method: 'POST', headers: { ...json, host: self } })
    const emptied = JSON.parse((await raw(port, P + '/trash/empty', { method: 'POST', headers: { ...json, host: self } })).text)
    assert.deepEqual(emptied.value, { purged: 1 })
    await writeFile(join(dir, 'docs', copy.value.doc.id + '.json'), '{broken')
    const s2 = new MindmapStorage(dir)
    const h2 = createHandler(s2)
    const server2: Server = createServer((req, res) => { void h2(req, res) })
    await new Promise<void>(r => server2.listen(0, '127.0.0.1', () => r()))
    const port2 = (server2.address() as { port: number }).port
    try {
      const h = { host: '127.0.0.1:' + port2 }
      // Corrupt files are quarantined when first read (here: by a search).
      assert.equal((await raw(port2, P + '/search?q=a', { headers: h })).status, 200)
      const first = JSON.parse((await raw(port2, P + '/library', { headers: h })).text)
      assert.equal(first.value.warnings.length, 1)
      const second = JSON.parse((await raw(port2, P + '/library', { headers: h })).text)
      assert.deepEqual(second.value.warnings, [])
      const q = JSON.parse((await raw(port2, P + '/health/quarantine', { headers: h })).text)
      assert.equal(q.value.length, 1)
      assert.match(q.value[0].name, /^docs\/.+\.corrupt-\d{8}-\d{6}\.json$/)
    } finally { server2.close() }
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
