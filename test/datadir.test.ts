import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { dataDirectory } from '../src/index.ts'

const home = resolve('/tmp/dsh-home')

test('dataDirectory: env overrides, new name, legacy reuse', () => {
  assert.equal(dataDirectory({ DSH_MINDPLAN_DIR: '/x/a' }, () => false), resolve('/x/a'))
  assert.equal(dataDirectory({ DSH_MINDMAP_DIR: '/x/b' }, () => false), resolve('/x/b'))
  assert.equal(dataDirectory({ DSH_HOME: home }, () => false), join(home, 'dsh-mindplan'))
  const legacy = join(home, 'dsh-mindmap')
  assert.equal(dataDirectory({ DSH_HOME: home }, p => p === legacy), legacy)
  assert.equal(dataDirectory({ DSH_HOME: home }, () => true), join(home, 'dsh-mindplan'))
})
