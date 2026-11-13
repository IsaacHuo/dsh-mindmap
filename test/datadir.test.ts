import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { dataDirectory } from '../src/index.ts'

test('dataDirectory: env override, DSH_HOME', () => {
  assert.equal(dataDirectory({ DSH_MINDMAP_DIR: '/x/a' }), resolve('/x/a'))
  const home = resolve('/tmp/dsh-home')
  assert.equal(dataDirectory({ DSH_HOME: home }), join(home, 'dsh-mindmap'))
})
