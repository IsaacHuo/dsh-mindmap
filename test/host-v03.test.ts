import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { MindmapStorage, type ChangeEvent } from '../src/host/storage.ts'
import { createHandler } from '../src/host/routes.ts'
import { renderOutline, runMindmapTool } from '../src/host/tools.ts'
import { pendingAi } from '../src/shared/aiOps.ts'

const tempDir = () => mkdtemp(join(tmpdir(), 'dsh-mindmap-v03-'))
const items = [{ text: 'a', children: [{ text: 'a1', children: [] }] }, { text: 'b', children: [] }]

test('tool: list, read, search, apply with a paper trail', async () => {
  const dir = await tempDir()
  try {
    const s = new MindmapStorage(dir, () => 1000)
    const { doc } = await s.createDoc({ title: 'Plan', items })
    const events: ChangeEvent[] = []
    s.onChange(e => events.push(e))
    const list = await runMindmapTool(s, { action: 'list' })
    assert.ok(list.ok && list.text.includes(doc.id))
    const read = await runMindmapTool(s, { action: 'read', docId: 'mindmap://' + doc.id })
    assert.ok(read.ok)
    const a = Object.values(doc.nodes).find(n => n.text === 'a')!.id
    const b = Object.values(doc.nodes).find(n => n.text === 'b')!.id
    assert.match(read.text, new RegExp('\\[' + a + '\\] a'))
    assert.match(read.text, /^  - \[.+\] a1$/m)
    const hit = await runMindmapTool(s, { action: 'search', query: 'a1' })
    assert.ok(hit.ok && hit.text.includes(doc.id))
    const r = await runMindmapTool(s, { action: 'apply', docId: doc.id, ops: [{ op: 'delete', nodeId: b }, { op: 'edit', nodeId: a, text: 'A' }, { op: 'add', parentId: a, text: 'new' }] }, { sessionId: 'sess-1' })
    assert.ok(r.ok, r.text)
    const saved = await s.getDoc(doc.id)
    assert.equal(saved.revision, doc.revision + 1)
    assert.ok(saved.nodes[b] !== undefined, 'deleted node is kept')
    assert.deepEqual(pendingAi(saved).map(p => p.kind).sort(), ['added', 'deleted', 'edited'])
    assert.equal(saved.nodes[a]!.ai?.sessionId, 'sess-1')
    assert.ok(events.some(e => e.kind === 'doc' && e.docId === doc.id && e.source === 'ai'))
    const read2 = await runMindmapTool(s, { action: 'read', docId: doc.id, nodeId: a })
    assert.match(read2.text, /AI 修改·待审.*原文: a/)
    // errors are results, not throws; nothing is written on failure
    const bad = await runMindmapTool(s, { action: 'apply', docId: doc.id, ops: [{ op: 'edit', nodeId: a, text: 'x' }, { op: 'delete', nodeId: 'zzzzzz' }] })
    assert.equal(bad.ok, false)
    assert.match(bad.text, /op #1/)
    assert.equal((await s.getDoc(doc.id)).revision, saved.revision)
    assert.equal((await runMindmapTool(s, { action: 'nope' })).ok, false)
    assert.equal((await runMindmapTool(s, { action: 'read', docId: 'mindmap://../x' })).ok, false)
    await s.trashDoc(doc.id)
    assert.match((await runMindmapTool(s, { action: 'apply', docId: doc.id, ops: [{ op: 'delete', nodeId: a }] })).text, /回收站/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('renderOutline truncates deep trees', async () => {
  const dir = await tempDir()
  try {
    const s = new MindmapStorage(dir, () => 1000)
    const { doc } = await s.createDoc({ title: 'T', items })
    const r = renderOutline(doc, doc.rootId, 0)
    assert.match(r.text, /1 child node\(s\) not shown/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('routes: /info and /events stream change events', async () => {
  const dir = await tempDir()
  const s = new MindmapStorage(dir, () => 1000)
  const handler = createHandler(s)
  const server: Server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/dsh-mindmap/api'
  const ac = new AbortController()
  try {
    const info = await (await fetch(base + '/info')).json() as { ok: boolean; value: { dataDir: string; docsDir: string } }
    assert.equal(info.value.dataDir, dir)
    assert.equal(info.value.docsDir, join(dir, 'docs'))
    const res = await fetch(base + '/events', { signal: ac.signal })
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = res.body!.getReader()
    const { doc } = await s.createDoc({ title: 'x' })
    let text = ''
    while (!text.includes('"kind":"doc"')) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    assert.ok(text.includes('event: change'))
    assert.ok(text.includes(doc.id))
    // a foreign Origin is still refused
    const foreign = await fetch(base + '/info', { headers: { origin: 'http://evil.example' } })
    assert.equal(foreign.status, 403)
  } finally {
    ac.abort()
    server.closeAllConnections()
    await new Promise<void>(r => server.close(() => r()))
    await rm(dir, { recursive: true, force: true })
  }
})
