// End-to-end acceptance run against the local harness (real host routes +
// built client) in headless Edge. Usage: npm run build && npm run e2e
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = join(root, '.tmp')
const dataDir = join(tmp, 'e2e-data')
const dlDir = join(tmp, 'e2e-downloads')
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
await rm(dataDir, { recursive: true, force: true })
await rm(dlDir, { recursive: true, force: true })
await mkdir(dlDir, { recursive: true })

const results = []
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('PASS', name) }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('FAIL', name, '-', e.message); throw e }
}

function startHarness() {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [join(root, 'scripts/harness.mjs'), '0'], { env: { ...process.env, DSH_MINDMAP_DIR: dataDir }, stdio: ['ignore', 'pipe', 'inherit'] })
    p.stdout.on('data', d => { const m = String(d).match(/harness (http:\/\/\S+)/); if (m) res({ proc: p, url: m[1] }) })
    p.on('exit', c => rej(new Error('harness exited ' + c)))
  })
}
const stopHarness = h => new Promise(r => { h.proc.once('exit', r); h.proc.kill() })
const sleep = ms => new Promise(r => setTimeout(r, ms))

let harness = await startHarness()
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--lang=zh-CN'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const errors = []
page.on('pageerror', e => errors.push(e.message))
page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()) })
const cdp = await page.createCDPSession()
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir })

const api = (path) => page.evaluate(async p => (await (await fetch('/dsh-mindmap/api' + p)).json()).value, path)
async function clickText(sel, text) {
  const ok = await page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find(e => e.textContent.trim() === t); if (!el) return false; el.click(); return true }, sel, text)
  assert.ok(ok, 'no ' + sel + ' with text ' + text)
}
async function saved() {
  await page.waitForFunction(() => document.querySelector('.mm-status')?.textContent === '已保存', { timeout: 8000 })
}
async function docTree() {
  const lib = await api('/library')
  const meta = lib.library.docs.find(d => d.trashedAt === undefined)
  const doc = await api('/docs/' + meta.id)
  const walk = id => doc.nodes[id].children.map(c => doc.nodes[c].children.length ? { [doc.nodes[c].text]: walk(c) } : doc.nodes[c].text)
  return { meta, doc, tree: walk(doc.rootId) }
}
const rowTexts = () => page.$$eval('[data-node-id]', l => l.map(r => r.querySelector('textarea.mm-input')?.value ?? r.querySelector('.mm-text')?.textContent ?? ''))
const focusedText = () => page.evaluate(() => document.activeElement?.value ?? null)
const key = async (k, mod) => { if (mod) await page.keyboard.down(mod); await page.keyboard.press(k); if (mod) await page.keyboard.up(mod); await sleep(60) }
const type = async t => { await page.keyboard.type(t); await sleep(60) }

try {
  await page.goto(harness.url, { waitUntil: 'networkidle0' })
  await step('page registers main slot and sidebar entry 思维导图', async () => {
    const h = await page.evaluate(() => window.__harness)
    assert.deepEqual(h, { main: ['dsh-mindmap'], side: ['思维导图'] })
  })

  await step('create doc 2027 个人规划 and build levels with Enter/Tab/Shift+Tab', async () => {
    await clickText('button', '新建文档')
    await page.waitForSelector('textarea.mm-title')
    await sleep(200)
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('mm-title')), true, 'title not focused')
    await type('2027 个人规划')
    await key('Enter')
    await page.waitForSelector('textarea.mm-input')
    await type('工作'); await key('Enter')
    await key('Tab'); await type('项目A'); await key('Enter')
    await type('项目B'); await key('Enter')
    await key('Tab', 'Shift'); await type('学习'); await key('Enter')
    await key('Tab'); await type('英语'); await key('Enter')
    await type('编程'); await key('Enter')
    await key('Tab', 'Shift'); await type('健康')
    await saved()
    const { meta, tree } = await docTree()
    assert.equal(meta.title, '2027 个人规划')
    assert.deepEqual(tree, [{ 工作: ['项目A', '项目B'] }, { 学习: ['英语', '编程'] }, '健康'])
  })

  await step('IME composition Enter does not split', async () => {
    await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })))
    await sleep(150)
    assert.equal(await page.$$eval('[data-node-id]', l => l.length), 7)
  })

  await step('Enter then Backspace on empty node removes it', async () => {
    await key('Enter')
    assert.equal(await page.$$eval('[data-node-id]', l => l.length), 8)
    await key('Backspace')
    assert.equal(await page.$$eval('[data-node-id]', l => l.length), 7)
    assert.equal(await focusedText(), '健康')
  })

  await step('Backspace at start merges into previous; undo restores', async () => {
    await sleep(1100)
    await key('Home')
    await key('Backspace')
    assert.equal(await page.$$eval('[data-node-id]', l => l.length), 6)
    assert.equal(await focusedText(), '编程健康')
    await key('z', 'Control')
    assert.equal(await page.$$eval('[data-node-id]', l => l.length), 7)
    await key('y', 'Control')
    assert.equal(await page.$$eval('[data-node-id]', l => l.length), 6, 'redo re-merges')
    await key('z', 'Control')
    assert.equal(await page.$$eval('[data-node-id]', l => l.length), 7, 'undo again')
    await saved()
    const { tree } = await docTree()
    assert.deepEqual(tree, [{ 工作: ['项目A', '项目B'] }, { 学习: ['英语', '编程'] }, '健康'])
  })

  await step('switch to 导图 shows same nodes; edit node in map', async () => {
    await clickText('[role=tab]', '导图')
    await page.waitForSelector('[data-map-node]')
    const n = await page.$$eval('[data-map-node]', l => l.length)
    assert.ok(n >= 8, 'map nodes ' + n)
    const target = await page.evaluateHandle(() => [...document.querySelectorAll('[data-map-node]')].find(g => g.textContent.trim() === '健康'))
    await target.asElement().click({ count: 2 })
    await page.waitForSelector('textarea.mm-map-edit')
    const dbg = () => page.evaluate(() => ({ active: document.activeElement?.className, value: document.activeElement?.value, edit: document.querySelector('textarea.mm-map-edit')?.value }))
    if (process.env.E2E_DEBUG) console.log('map edit open', JSON.stringify(await dbg()))
    await key('a', 'Control')
    if (process.env.E2E_DEBUG) console.log('after ctrl+a', JSON.stringify(await dbg()))
    await type('健身')
    if (process.env.E2E_DEBUG) console.log('after type', JSON.stringify(await dbg()))
    await key('Enter')
    await sleep(150)
    await page.screenshot({ path: join(tmp, 'e2e-map.png') })
    await clickText('[role=tab]', '大纲')
    await page.waitForSelector('[data-node-id]')
    const texts = await rowTexts()
    assert.ok(texts.includes('健身'), 'outline texts ' + texts.join(','))
    assert.equal(texts.length, 7)
    await saved()
  })

  await step('drag 健身 before 工作 (HTML5 DnD)', async () => {
    const ok = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-node-id]')]
      const src = rows.find(r => (r.querySelector('textarea.mm-input')?.value ?? r.querySelector('.mm-text')?.textContent) === '健身')
      const dst = rows.find(r => (r.querySelector('textarea.mm-input')?.value ?? r.querySelector('.mm-text')?.textContent) === '工作')
      if (!src || !dst) return false
      const dt = new DataTransfer()
      const bullet = src.querySelector('.mm-bullet')
      bullet.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const r = dst.getBoundingClientRect()
      const at = { clientX: r.left + 60, clientY: r.top + 2, bubbles: true, cancelable: true, dataTransfer: dt }
      dst.dispatchEvent(new DragEvent('dragenter', at))
      dst.dispatchEvent(new DragEvent('dragover', at))
      dst.dispatchEvent(new DragEvent('drop', at))
      bullet.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
      return true
    })
    assert.ok(ok)
    await saved()
    const { tree } = await docTree()
    assert.deepEqual(tree, ['健身', { 工作: ['项目A', '项目B'] }, { 学习: ['英语', '编程'] }])
  })

  await step('search finds node text', async () => {
    await page.type('input[type=search]', '英语')
    await page.waitForSelector('.mm-hit', { timeout: 4000 })
    const t = await page.$eval('.mm-hit', e => e.textContent)
    assert.ok(t.includes('2027 个人规划') && t.includes('英语'), t)
    await page.click('input[type=search]', { count: 3 }); await key('Backspace')
  })

  await step('export Markdown and PNG', async () => {
    for (const label of ['导出 Markdown (.md)', '导出图片 (.png)']) {
      await page.click('button[aria-label=导出]')
      await clickText('.mm-menu button, [role=menu] button, [role=menuitem]', label)
      await sleep(1500)
    }
    const files = await readdir(dlDir)
    const md = files.find(f => f.endsWith('.md')); const png = files.find(f => f.endsWith('.png'))
    assert.ok(md && png, 'downloads ' + files.join(','))
    const text = await readFile(join(dlDir, md), 'utf8')
    assert.equal(text.trim(), '# 2027 个人规划\n\n- 健身\n- 工作\n  - 项目A\n  - 项目B\n- 学习\n  - 英语\n  - 编程')
    const buf = await readFile(join(dlDir, png))
    assert.equal(buf.subarray(1, 4).toString(), 'PNG')
  })

  await step('data survives host restart', async () => {
    const before = await docTree()
    await stopHarness(harness)
    harness = await startHarness()
    await page.goto(harness.url, { waitUntil: 'networkidle0' })
    await page.waitForSelector('[data-node-id]')
    const after = await docTree()
    assert.deepEqual(after.tree, before.tree)
    assert.equal(after.meta.title, '2027 个人规划')
    const ids = Object.keys(after.doc.nodes).sort(); assert.deepEqual(ids, Object.keys(before.doc.nodes).sort(), 'node ids stable')
  })

  await step('dark theme screenshots', async () => {
    await page.screenshot({ path: join(tmp, 'e2e-outline.png') })
    await page.goto(harness.url + '?dark', { waitUntil: 'networkidle0' })
    await page.waitForSelector('[data-node-id]')
    await page.screenshot({ path: join(tmp, 'e2e-outline-dark.png') })
    await clickText('[role=tab]', '导图')
    await page.waitForSelector('[data-map-node]')
    await sleep(200)
    await page.screenshot({ path: join(tmp, 'e2e-map-dark.png') })
    await clickText('[role=tab]', '大纲')
  })

  await step('no page errors', async () => { assert.deepEqual(errors, []) })
} finally {
  await browser.close()
  await stopHarness(harness)
  const failed = results.filter(r => r[0] === 'FAIL').length
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed')
  if (failed > 0) process.exitCode = 1
}
