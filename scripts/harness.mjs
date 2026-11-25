// Local harness: serves the built client inside a minimal fake DSH page
// (React UMD + __ModuleLoader__ + mock slots) and mounts the REAL host half
// (lib/index.js) on a plain http server. Data dir: $DSH_MINDMAP_DIR
// (default .tmp/harness-data). Usage: node scripts/harness.mjs [port]
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.DSH_MINDMAP_DIR ||= resolve(root, '.tmp/harness-data')
const host = await import(pathToFileURL(join(root, 'lib/index.js')).href)

const routes = []
const tools = []
const services = {
  webServer: { register(r) { routes.push(r); return () => {} } },
  tools: { register(def) { tools.push(def); return () => {} } },
  systemPrompt: { section() { return () => {} } },
}
const ctx = {
  effect(fn) { fn() },
  inject(deps, cb) {
    const sub = { ...ctx }
    for (const d of deps) sub[d] = services[d]
    cb(sub)
  },
}
host.apply(ctx)

// POST /__tool {args, sessionId?}: run the registered agent tool (e2e of AI edits).
routes.push({ kind: 'exact', path: '/__tool', async handler(req, res) {
  let body = ''
  for await (const c of req) body += c
  const { args, sessionId } = JSON.parse(body || '{}')
  const out = await tools[0].execute(args, { agent: sessionId ? { id: sessionId } : undefined })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(out))
} })

const files = {
  '/react.js': 'node_modules/react/umd/react.development.js',
  '/react-dom.js': 'node_modules/react-dom/umd/react-dom.development.js',
  '/client.js': 'lib/client.js',
}

const page = (dark) => '<!doctype html><html><head><meta charset="utf-8"><title>dsh-mindmap harness</title>' +
  '<style>html,body{margin:0;height:100%;font-family:system-ui,"Microsoft YaHei",sans-serif}' +
  'body{display:flex;background:var(--dsw-bg,#fff);color:var(--dsw-text,#222)}' +
  'body[data-ds-dark-theme]{--dsw-bg:#1e1f22;--dsw-bg-panel:#26272b;--dsw-bg-hover:#2f3035;--dsw-bg-elevated:#2b2c30;--dsw-text:#e6e6e6;--dsw-text-primary:#f2f2f2;--dsw-text-secondary:#9a9ca3;--dsw-border:#35363b;--dsw-border-strong:#45464c;--dsw-accent:#5b8cff}' +
  '#rail{width:120px;border-right:1px solid #8884;padding:8px;font-size:12px}#rail div{display:flex;gap:6px;align-items:center;padding:4px}#root{flex:1;min-width:0;height:100%}</style>' +
  '<script src="/react.js"></script><script src="/react-dom.js"></script>' +
  '<script>window.__mods={};window.__ModuleLoader__={load:function(d){var R=window.React;var jsx=function(t,p,k){var q=Object.assign({},p);var c=q.children;delete q.children;if(k!==undefined)q.key=k;return c===undefined?R.createElement(t,q):R.createElement(t,q,c)};var jsxs=function(t,p,k){var q=Object.assign({},p);var c=q.children||[];delete q.children;if(k!==undefined)q.key=k;return R.createElement.apply(null,[t,q].concat(c))};' +
  'var mods={react:R,"react-dom":window.ReactDOM,"react-dom/client":window.ReactDOM,"react/jsx-runtime":{jsx:jsx,jsxs:jsxs,Fragment:R.Fragment}};window.__mods[d.id]=d.factory(function(n){if(!(n in mods))throw new Error("missing module "+n);return mods[n]})}};</script>' +
  '<script src="/client.js"></script></head><body' + (dark ? ' data-ds-dark-theme' : '') + '><div id="rail"></div><div id="root"></div><script>' +
  'var m=window.__mods["@huoweifang/dsh-mindmap"];var mains=[],side=[];var slots={inject:function(s,f){return f()},register:function(meta,C){(meta.name==="main"?mains:side).push({meta:meta,C:C});return function(){}}};' +
  'm.apply({get:function(n){return n==="slots"?slots:undefined},effect:function(f){window.__dispose=f()}});' +
  'var R=React;side.forEach(function(s){var el=document.createElement("div");el.id="rail-"+s.meta.id;document.getElementById("rail").appendChild(el);ReactDOM.createRoot(el).render(R.createElement(R.Fragment,null,R.createElement(s.C,{size:16}),R.createElement("span",null,s.meta.label())))});' +
  'window.__harness={main:mains.map(function(x){return x.meta.key}),side:side.map(function(x){return x.meta.label()})};' +
  'ReactDOM.createRoot(document.getElementById("root")).render(R.createElement(mains[0].C));</script></body></html>'

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  for (const r of routes) {
    if (r.kind === 'prefix' ? url.pathname.startsWith(r.path) : url.pathname === r.path) return void r.handler(req, res)
  }
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return void res.end(page(url.searchParams.has('dark'))) }
  const f = files[url.pathname]
  if (f !== undefined) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); return void res.end(await readFile(join(root, f))) }
  res.writeHead(404); res.end('not found')
})
const port = Number(process.argv[2] ?? process.env.HARNESS_PORT ?? 0)
server.listen(port, '127.0.0.1', () => {
  console.log('harness http://127.0.0.1:' + server.address().port + '/  data=' + process.env.DSH_MINDMAP_DIR)
})
