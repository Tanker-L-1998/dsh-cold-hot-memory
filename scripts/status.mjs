/**
 * Print (and refresh) the memory status for one project — the same report the
 * plugin writes into .dsh-memory/STATUS.md, so you can check a project without
 * starting a conversation.
 *
 * Usage:
 *   node scripts/status.mjs                 # current directory
 *   node scripts/status.mjs <project-root>  # any project
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Memory } from '../lib/store.js'

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '?'
  }
})()

const cwd = resolve(process.argv[2] ?? process.cwd())
const root = join(cwd, '.dsh-memory')

if (!existsSync(root)) {
  console.log(`没有记忆：${root}`)
  console.log('（这个项目还没用过记忆；在这个目录开一次会话就会自动创建）')
  process.exit(0)
}

/** Ancestors are read-only shared layers, same rule as the plugin. */
function sharedLayers(from) {
  const layers = []
  let dir = dirname(from)
  for (let depth = 0; depth < 5 && dir && dir !== dirname(dir); depth++) {
    const candidate = join(dir, '.dsh-memory')
    if (existsSync(candidate)) layers.push(candidate)
    dir = dirname(dir)
  }
  return layers
}

/** Conversation is the most recently touched one under conv/. */
function newestConversation(store) {
  const convRoot = join(store.root, 'conv')
  if (!existsSync(convRoot)) return 'c-none'
  const dirs = readdirSync(convRoot).filter((name) => {
    try {
      return statSync(join(convRoot, name)).isDirectory()
    } catch {
      return false
    }
  })
  if (!dirs.length) return 'c-none'
  dirs.sort((a, b) => {
    try {
      return statSync(join(convRoot, b, 'state.md')).mtimeMs - statSync(join(convRoot, a, 'state.md')).mtimeMs
    } catch {
      return 0
    }
  })
  return dirs[0]
}

const store = new Memory(root)
const conv = newestConversation(store)
const parents = sharedLayers(cwd)
const layers = 1 + parents.length

store.writeStatus(conv, { layers, health: 'OK', version: PLUGIN_VERSION })
console.log(store.statusReport(conv, { layers, health: 'OK', version: PLUGIN_VERSION }))
if (parents.length) {
  console.log('父级共享层：')
  for (const parent of parents) console.log(`  ${parent}（${new Memory(parent).decisions().length} 条结论）`)
}
console.log(`状态文件：${join(root, 'STATUS.md')}`)
