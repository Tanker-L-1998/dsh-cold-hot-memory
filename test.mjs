import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { MemoryStore, estimateTokens, tokenize, scanSecrets } from './lib/engine.js'

const dir = mkdtempSync(join(tmpdir(), 'memtest-'))
const store = new MemoryStore(dir, { limits: { hotTokens: 120, warmTokens: 400, manifestTokens: 300 } })

let passed = 0
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`) }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); process.exitCode = 1 }
}

console.log('token estimate')
ok('CJK counted at ~1 token/char', () => {
  const t = estimateTokens('当前目标是完成第一版设计')
  assert.ok(t >= 12 && t <= 20, `got ${t}`)
})
ok('English roughly 4 chars/token', () => {
  const t = estimateTokens('the quick brown fox jumps over the lazy dog')
  assert.ok(t >= 8 && t <= 12, `got ${t}`)
})

console.log('tokenizer')
ok('Chinese bigrams restore recall', () => {
  const t = tokenize('当前目标设计')
  assert.ok(t.includes('目标') && t.includes('设计'), t.join(','))
})

console.log('secrets')
ok('blocks api key', () => {
  assert.ok(scanSecrets('api_key: sk-abcdefghijklmnopqrstuvwxyz123').length > 0)
})
ok('does not trip on "token 预算"', () => {
  assert.equal(scanSecrets('token 预算还剩 2000').length, 0)
})
ok('catches Chinese 密码 label', () => {
  assert.ok(scanSecrets('密码：hunter2hunter2').length > 0)
})

console.log('write / dedup / conflict')
ok('writes a hot record', () => {
  const r = store.put({ id: 'MEM-001', tier: 'hot', title: '当前目标', content: '完成冷热记忆插件第一版', tags: ['design'], scope: 'harness' })
  assert.equal(r.status, 'written')
  assert.equal(r.record.tier, 'hot')
})
ok('identical content is skipped', () => {
  const r = store.put({ id: 'MEM-002', tier: 'warm', title: 'other', content: '完成冷热记忆插件第一版' })
  assert.equal(r.status, 'skipped')
  assert.equal(r.record.id, 'MEM-001')
})
ok('same title different content flags a conflict', () => {
  const r = store.put({ id: 'MEM-003', tier: 'warm', title: '当前目标', content: '改为先做检索层', scope: 'harness' })
  assert.equal(r.conflictWith, 'MEM-001')
})
ok('rejects secrets', () => {
  assert.throws(() => store.put({ id: 'MEM-009', tier: 'warm', title: 'k', content: 'api_key: sk-abcdefghijklmnopqrstuvwxyz123' }), /sensitive/)
})

console.log('hot overflow demotes instead of failing')
ok('oldest hot record moves to warm', () => {
  store.put({ id: 'MEM-010', tier: 'hot', title: 'a', content: '甲'.repeat(80) })
  const r = store.put({ id: 'MEM-011', tier: 'hot', title: 'b', content: '乙'.repeat(80) })
  assert.ok(r.demoted.length > 0, 'expected demotion')
  assert.equal(store.list({ tier: 'hot' }).length >= 1, true)
})

console.log('query')
ok('Chinese query hits the right record', () => {
  const res = store.query('检索 层')
  assert.ok(res.length > 0)
  assert.equal(res[0].id, 'MEM-003')
})
ok('tag filter works', () => {
  const res = store.list({ tags: ['design'] })
  assert.equal(res.length, 1)
})

console.log('manifest')
ok('manifest fits the budget and has a stable digest', () => {
  const m = store.manifest()
  assert.ok(m && m.tokens <= 300, `tokens=${m?.tokens}`)
  assert.equal(m.digest, store.manifest().digest)
})

console.log('lifecycle')
ok('forget archives and keeps the record consistent', () => {
  const r = store.forget('MEM-003')
  assert.equal(r.tier, 'cold')
  assert.equal(r.status, 'archived')
})
ok('sweep archives expired records', () => {
  store.put({ id: 'MEM-020', tier: 'warm', title: 'old', content: '过期内容', expiresAt: '2020-01-01T00:00:00.000Z' })
  const swept = store.sweep()
  assert.ok(swept.some((r) => r.id === 'MEM-020'))
})
ok('stats reports tiers', () => {
  const s = store.stats()
  assert.equal(s.total > 0, true)
  assert.ok(typeof s.tokensByTier.hot === 'number')
})

console.log('compaction')
ok('compact preserves all live records', () => {
  const before = store.stats().total
  store.compact()
  const again = new MemoryStore(dir, { limits: { hotTokens: 120, warmTokens: 400, manifestTokens: 300 } })
  assert.equal(again.stats().total, before)
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
