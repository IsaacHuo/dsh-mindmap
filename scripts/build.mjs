// Build lib/index.js (host, ESM for Node) and lib/client.js (web, CJS wrapped
// in the DSH module loader; React comes from the host page, never bundled).
import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')
await rm(lib, { recursive: true, force: true })
await mkdir(lib, { recursive: true })

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(lib, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  legalComments: 'none',
  logLevel: 'warning',
})

const client = await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
})
const code = client.outputFiles[0].text
const wrapped = 'window.__ModuleLoader__.load({id:"@huoweifang/dsh-mindmap",factory:function(require){var module={exports:{}},exports=module.exports;\n' + code + '\nreturn module.exports}});\n'
await writeFile(join(lib, 'client.js'), wrapped)
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
console.log('built', pkg.name, pkg.version, '→ lib/index.js, lib/client.js (' + (wrapped.length / 1024).toFixed(1) + ' KB)')
