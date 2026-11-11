/**
 * Capability audit: proves every capability this plugin claims is actually
 * present in the source, instead of trusting a changelog.
 *
 * Run before every release:
 *   node scripts/verify.mjs
 *
 * Exits 1 if any capability is missing. Static only — it does not execute the
 * plugin, so it cannot replace `node test-store.mjs`, only catch claims that
 * were never implemented.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = ['lib/store.js', 'lib/index.js']
  .map((file) => readFileSync(join(root, file), 'utf8'))
  .join('\n')

/** Each entry: capability, and a pattern that must appear in the source. */
const CAPABILITIES = [
  ['三类对象 state / cards / decisions', /putCard\(|putDecision\(|writeState\(/],
  ['对话级与项目级作用域', /'shared'|"shared"|shared\//],
  ['父级共享层', /sharedLayers\(/],
  ['五态状态机', /PHASES\s*=/],
  ['30 / 90 天老化常数', /DORMANT_AFTER_DAYS[\s\S]*ARCHIVE_AFTER_DAYS/],
  ['每轮自动老化', /store\.sweep\(\)/],
  ['结论不可变 + supersede', /supersede\(/],
  ['交付流水', /logDelivery\(/],
  ['否决记录', /vetoes/],
  ['脱敏拦截', /scanSecrets\(/],
  ['8KB 卡片上限', /MAX_CARD_BYTES/],
  ['600 token 状态上限', /MAX_STATE_TOKENS/],
  ['空标题拦截', /title is required/],
  ['提及即回活', /revive\(/],
  ['外部修改检测', /external_edit/],
  ['待办探测', /tools\.get\('todo_write'/],
  ['promote 转卡片', /action === 'promote'/],
  ['单写者 inbox', /enqueue\(|flush\(/],
  ['跨项目引用', /importRefFrom/],
  ['旧全局库接管', /adoptLegacy/],
  ['心跳', /heartbeat\(/],
  ['健康探针', /probeHealth\(/],
  ['STATUS.md 状态文件', /writeStatus\(/],
  ['宿主版本兼容检测', /TESTED_DSH|probeHostVersion/],
  ['写失败重试', /attempts = 3|appendWithRetry/],
  ['原子写 tmp + rename', /writeAtomic/],
  ['schema 版本迁移', /SCHEMA_VERSION/],
  ['产物落地自动交付', /artifactsSatisfied\(/],
]

let failures = 0
for (const [name, pattern] of CAPABILITIES) {
  const ok = pattern.test(source)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

console.log('')
if (failures) {
  console.error(`${failures} capability(ies) missing — do not release.`)
  process.exit(1)
}
console.log(`all ${CAPABILITIES.length} capabilities present`)
console.log('next: node test-store.mjs')
