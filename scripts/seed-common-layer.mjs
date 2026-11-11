import { Memory } from 'file:///E:/DeepSeekHarness/dsh-plugin-memory/lib/store.js'

/**
 * Seed a workspace-level ("common") memory layer with conventions that hold for
 * every project underneath it.
 *
 * Usage: node scripts/seed-common-layer.mjs <workspace-root>
 * Example: node scripts/seed-common-layer.mjs E:/DeepSeekHarness
 */
const workspace = process.argv[2]
if (!workspace) {
  console.error('usage: node scripts/seed-common-layer.mjs <workspace-root>')
  process.exit(1)
}

const m = new Memory(`${workspace.replace(/\/+$/, '')}/.dsh-memory`).ensure('Harness 通用')

const d1 = m.putDecision({
  title: '记忆跟随工作区，一个工作区一层；批量作业的目标用卡片表达',
  body:
    '每个工作区（例如 E:/DeepSeekHarness/白帽工作区）有一层 .dsh-memory，子目录默认不单独建层。' +
    '批量作业里的单个目标（某个 SRC 厂商、某一章稿件）用卡片记录，不用目录——' +
    '按目录切分会把一次批量作业切成碎片，反而看不到全貌。',
  evidence: ['2026-11-11 与用户确认的工作流'],
  vetoes: ['按每个 SRC 子项目建一层记忆：单个厂商不是独立工作单元'],
})

const d2 = m.putDecision({
  title: 'state 只写现在，历史进结论',
  body:
    'state 每次覆盖写，只放：目标、进展、阻塞、下一步、指针。' +
    '历史结论进 decisions（不可变、可 supersede）。' +
    '在 state 里保留历史章节，会在结论更新后变成没人维护的旧账。',
  evidence: ['白帽工作区 state 与番茄工作区 state 的对比'],
  vetoes: ['在 state 里维护历史结论小节：与不可变结论重复且会过时'],
})

console.log(JSON.stringify({ root: m.root, decisions: [d1.id, d2.id] }, null, 2))
