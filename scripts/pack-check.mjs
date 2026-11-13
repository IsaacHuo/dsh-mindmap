// Verify the npm tarball: required runtime files present, nothing dev-only
// leaks in, icon within the DSH 256 KiB limit. Run after `npm run build`.
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const raw = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', shell: process.platform === 'win32' })
const [info] = JSON.parse(raw.slice(raw.indexOf('[')))
const files = info.files.map(f => f.path.replace(/\\/g, '/')).sort()
const required = ['package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'LICENSE', 'README.md', 'README.zh-CN.md']
const missing = required.filter(f => !files.includes(f))
const leaked = files.filter(f => /^(src|test|e2e|scripts|node_modules|\.tmp|\.github|docs)\//.test(f) || /\.(ts|tsx|map|log)$/.test(f))
const iconBytes = statSync('icon.svg').size
console.log(info.name + '@' + info.version, files.length + ' files,', (info.size / 1024).toFixed(1) + ' KB packed,', (info.unpackedSize / 1024).toFixed(1) + ' KB unpacked')
for (const f of files) console.log('  ' + f)
let ok = true
if (missing.length) { ok = false; console.error('missing:', missing.join(', ')) }
if (leaked.length) { ok = false; console.error('dev-only files in tarball:', leaked.join(', ')) }
if (iconBytes > 256 * 1024) { ok = false; console.error('icon.svg exceeds 256 KiB') }
if (!ok) process.exit(1)
console.log('pack check OK')
