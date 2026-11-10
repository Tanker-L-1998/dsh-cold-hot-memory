import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { Memory, PHASES, decodeCard, encodeCard } from './lib/store.js'

const dir = mkdtempSync(join(tmpdir(), 'memstore-'))
const mem = new Memory(dir).ensure('测试项目')

let passed = 0
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`) }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); process.exitCode = 1 }
}

const DAY = 86400000
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString()

console.log('frontmatter')
ok('round-trips scalars and arrays', () => {
  const card = { id: 'C-1', title: '鉴权', phase: 'executing', vetoes: ['中间件：拿不到 path', '前端校验：可绕过'], body: '正文' }
  const back = decodeCard(encodeCard(card))
  assert.equal(back.title, '鉴权')
  assert.deepEqual(back.vetoes, ['中间件：拿不到 path', '前端校验：可绕过'])
  assert.equal(back.body, '正文')
})

console.log('setup')
ok('creates project file and shared dirs', () => {
  assert.ok(existsSync(join(dir, 'project.json')))
  assert.ok(existsSync(join(dir, 'shared', 'decisions')))
  assert.ok(existsSync(join(dir, 'shared', 'closed.md')))
})

console.log('state')
ok('writes and reads state', () => {
  mem.writeState('conv1', '正在做鉴权重构')
  assert.match(mem.readState('conv1'), /鉴权重构/)
})
ok('keeps a backup of the previous state', () => {
  mem.writeState('conv1', '新的状态')
  assert.match(mem.readState('conv1'), /新的状态/)
  assert.ok(existsSync(join(dir, 'conv', 'conv1', 'state.md.bak')))
})

console.log('cards')
ok('creates a card in planning by default', () => {
  const c = mem.putCard('conv1', { title: '导出功能', body: '目标：支持 Excel' })
  assert.match(c.id, /^C-\d{4}$/)
  assert.equal(c.phase, 'planning')
})
ok('advances through phases', () => {
  const c = mem.putCard('conv1', { title: '鉴权重构' })
  const next = mem.advance('conv1', c.id, 'executing')
  assert.equal(next.phase, 'executing')
  assert.ok(next.delivered_at === undefined)
  const delivered = mem.advance('conv1', c.id, 'delivered')
  assert.equal(delivered.phase, 'delivered')
  assert.ok(delivered.delivered_at)
})
ok('filters cards by phase set', () => {
  const active = mem.cards('conv1', { phases: ['planning', 'executing'] })
  assert.equal(active.length, 1)
  assert.equal(active[0].title, '导出功能')
})
ok('rejects unknown phases', () => {
  const c = mem.putCard('conv1', { title: 'x' })
  assert.throws(() => mem.advance('conv1', c.id, 'nonsense'), /unknown phase/)
})

console.log('aging')
ok('delivered older than 30 days becomes dormant', () => {
  mem.putCard('conv1', { title: '旧任务', phase: 'delivered', delivered_at: iso(31) })
  const moved = mem.sweep()
  assert.ok(moved.some((c) => c.title === '旧任务' && c.phase === 'dormant'))
})
ok('dormant older than 90 days becomes archived', () => {
  mem.putCard('conv1', { title: '更旧的任务', phase: 'dormant', delivered_at: iso(91) })
  mem.sweep()
  const archived = mem.cards('conv1', { phases: ['archived'] })
  assert.ok(archived.some((c) => c.title === '更旧的任务'))
})
ok('recent delivered cards are left alone', () => {
  mem.putCard('conv1', { title: '刚交付', phase: 'delivered', delivered_at: iso(1) })
  mem.sweep()
  const delivered = mem.cards('conv1', { phases: ['delivered'] })
  assert.ok(delivered.some((c) => c.title === '刚交付'))
})

console.log('decisions')
ok('stores a conclusion', () => {
  const d = mem.putDecision({ title: '鉴权放网关', body: '因为中间件拿不到 path', evidence: ['seq:42-58'] })
  assert.match(d.id, /^D-\d{4}$/)
  assert.equal(mem.decisions().length, 1)
})
ok('superseding archives the old one', () => {
  const old = mem.decisions()[0]
  mem.supersede(old.id, { title: '鉴权放网关注入层', body: '网关只做校验' })
  assert.equal(mem.decisions().length, 1)
  assert.equal(mem.decisions()[0].title, '鉴权放网关注入层')
  assert.deepEqual(mem.decisions()[0].supersedes, [old.id])
  assert.equal(readdirSync(join(dir, 'shared', 'archive')).length, 1)
})

console.log('delivery log')
ok('appends one line per delivery', () => {
  mem.logDelivery({ task: '白帽轮次-3', version: 'v1', artifact: 'logs/scan-3.json' })
  const text = readFileSync(join(dir, 'shared', 'closed.md'), 'utf8')
  assert.match(text, /白帽轮次-3/)
})

console.log('manifest')
ok('includes state, open cards and decisions', () => {
  const m = mem.manifest('conv1')
  assert.ok(m)
  assert.match(m.text, /State:/)
  assert.match(m.text, /Open:/)
  assert.match(m.text, /Decisions:/)
  assert.ok(m.digest)
})
ok('an empty conversation still sees project-level decisions', () => {
  const m = mem.manifest('conv-empty')
  assert.ok(m, 'expected a manifest from project decisions alone')
  assert.match(m.text, /Decisions:/)
  assert.ok(!/Open:/.test(m.text), 'no conversation cards should appear')
})
ok('returns null only when the project is empty too', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'memstore-empty-'))
  const empty = new Memory(fresh).ensure('空项目')
  assert.equal(empty.manifest('conv-x'), null)
  rmSync(fresh, { recursive: true, force: true })
})

console.log('validation')
ok('rejects secrets in a card', () => {
  assert.throws(() => mem.putCard('conv1', { title: 'k', body: 'api_key: sk-abcdefghijklmnopqrstuvwxyz123' }), /sensitive/)
})
ok('rejects an empty title', () => {
  assert.throws(() => mem.putCard('conv1', { title: '   ', body: 'x' }), /title is required/)
})
ok('rejects a state over 600 tokens', () => {
  assert.throws(() => mem.writeState('conv1', '很'.repeat(700)), /over the 600 limit/)
})
ok('rejects a card over 8KB', () => {
  assert.throws(() => mem.putCard('conv1', { title: 'big', body: 'x'.repeat(9000) }), /over the 8192 limit/)
})

console.log('revive')
ok('a dormant card revives to executing', () => {
  const c = mem.putCard('conv1', { title: '回来干活', phase: 'dormant' })
  assert.equal(mem.revive('conv1', c.id).phase, 'executing')
})

console.log('external edit')
ok('flags a card edited outside the plugin', () => {
  const c = mem.putCard('conv1', { title: '手改我', body: '原文' })
  const cardsDir = join(dir, 'conv', 'conv1', 'cards')
  const file = readdirSync(cardsDir).find((n) => n.startsWith(c.id))
  writeFileSync(join(cardsDir, file), readFileSync(join(cardsDir, file), 'utf8').replace('原文', '我手改的'), 'utf8')
  assert.equal(mem.cards('conv1').find((x) => x.id === c.id).external_edit, true)
})

console.log('inbox')
ok('enqueue then flush applies project-scope writes once', () => {
  const before = mem.decisions().length
  mem.enqueue('convA', { op: 'decision', decision: { title: '队列里的结论', body: '通过 inbox 写入' } })
  mem.enqueue('convB', { op: 'delivery', delivery: { task: '队列任务', version: 'v1', artifact: 'x' } })
  assert.equal(mem.pendingInbox(), 2)
  const result = mem.flush()
  assert.equal(result.applied, 2)
  assert.equal(mem.decisions().length, before + 1)
  assert.equal(mem.pendingInbox(), 0)
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
