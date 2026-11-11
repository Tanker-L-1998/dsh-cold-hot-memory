/**
 * dsh-cold-hot-memory — storage layer for the current design.
 *
 * Two scopes, three object types:
 *
 *   <root>/project.json             project id + name
 *   <root>/shared/                  project scope, read-only for conversations
 *     decisions/D-xxxx.md           conclusions, immutable
 *     archive/                      superseded conclusions
 *     closed.md                     one line per delivered task
 *     refs/                         read-only snapshots from other projects
 *     active.md                     which conversation is doing what
 *   <root>/conv/<convId>/           conversation scope, only that conversation writes
 *     state.md                      what we are doing right now (overwritten)
 *     cards/C-xxxx.md               open loops, five fields each
 *
 * A card carries a phase; aging moves it along:
 *   planning -> executing -> delivered -> dormant -> archived
 *
 * No third-party imports: this module must load even when peer packages are
 * missing inside the host.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { estimateTokens, scanSecrets } from './engine.js'

export const PHASES = ['planning', 'executing', 'delivered', 'dormant', 'archived']
export const DORMANT_AFTER_DAYS = 30
export const ARCHIVE_AFTER_DAYS = 90
/** A card bigger than this gets truncated by the model's attention; split it. */
export const MAX_CARD_BYTES = 8192
/** One screen is about 600 tokens; beyond that the state stops being a glance. */
export const MAX_STATE_TOKENS = 600

/* ------------------------------------------------------------------ */
/* tiny frontmatter codec (no yaml dependency)                          */
/* ------------------------------------------------------------------ */

function encodeValue(value) {
  return String(value).replace(/\r?\n/g, ' ').trim()
}

function encodeCard(card) {
  const lines = ['---']
  for (const [key, value] of Object.entries(card)) {
    if (key === 'body') continue
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${encodeValue(item)}`)
    } else {
      lines.push(`${key}: ${encodeValue(value)}`)
    }
  }
  lines.push('---', '', String(card.body ?? '').trim(), '')
  return lines.join('\n')
}

function decodeCard(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { body: text.trim() }
  const meta = {}
  let listKey = null
  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim()) continue
    const item = /^\s+-\s+(.*)$/.exec(raw)
    if (item && listKey) {
      meta[listKey].push(item[1].trim())
      continue
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw)
    if (!pair) continue
    const [, key, value] = pair
    if (value === '') {
      meta[key] = []
      listKey = key
    } else {
      meta[key] = value.trim()
      listKey = null
    }
  }
  return { ...meta, body: match[2].trim() }
}

/* ------------------------------------------------------------------ */

const sha = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
const nowIso = () => new Date().toISOString()
/** Local calendar date: a delivery logged at 00:30 belongs to that day, not UTC's. */
function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const daysBetween = (a, b) => (b - a) / 86400000

function nextId(prefix, dirPath, taken = []) {
  let max = 0
  const scan = (name) => {
    const m = new RegExp(`^${prefix}-(\\d+)`).exec(name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  if (existsSync(dirPath)) for (const name of readdirSync(dirPath)) scan(name)
  for (const id of taken) scan(id)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function safeName(title) {
  return encodeValue(title).replace(/[\\/:*?"<>|]/g, '-').slice(0, 40) || 'untitled'
}

/* ------------------------------------------------------------------ */

export class Memory {
  constructor(root) {
    this.root = root
    this.shared = join(root, 'shared')
    this.decisionsDir = join(this.shared, 'decisions')
    this.archiveDir = join(this.shared, 'archive')
  }

  convDir(convId) {
    return join(this.root, 'conv', String(convId))
  }

  cardsDir(convId) {
    return join(this.convDir(convId), 'cards')
  }

  /* ---------------- setup ---------------- */

  ensure(projectName = 'memory-project') {
    const dirs = [
      this.root,
      this.shared,
      this.decisionsDir,
      this.archiveDir,
      join(this.shared, 'refs'),
    ]
    for (const dir of dirs) mkdirSync(dir, { recursive: true })
    const projectFile = join(this.root, 'project.json')
    if (!existsSync(projectFile)) {
      const id = sha(`${projectName}:${Date.now()}`)
      writeFileSync(projectFile, JSON.stringify({ id, name: projectName, created_at: nowIso() }, null, 2), 'utf8')
    }
    const closed = join(this.shared, 'closed.md')
    if (!existsSync(closed)) writeFileSync(closed, '# 已交付\n\n日期 | 任务 | 版本 | 产物 | 完成度\n---|---|---|---|---\n', 'utf8')
    const active = join(this.shared, 'active.md')
    if (!existsSync(active)) writeFileSync(active, '# 各对话当前在做什么\n', 'utf8')
    return this
  }

  /* ---------------- conversation state ---------------- */

  statePath(convId) {
    return join(this.convDir(convId), 'state.md')
  }

  readState(convId) {
    const p = this.statePath(convId)
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }

  /** Overwrite the state file, keeping the previous version for diffing. */
  writeState(convId, text) {
    const body = String(text ?? '').trim()
    if (!body) throw new Error('state text is required')
    const secrets = scanSecrets(body)
    if (secrets.length) throw new Error(`state looks sensitive (${secrets.length} pattern hit); redact it first`)
    const tokens = estimateTokens(body)
    if (tokens > MAX_STATE_TOKENS) {
      throw new Error(`state is ${tokens} tokens, over the ${MAX_STATE_TOKENS} limit; move detail into cards`)
    }
    const p = this.statePath(convId)
    mkdirSync(dirname(p), { recursive: true })
    if (existsSync(p)) writeFileSync(`${p}.bak`, readFileSync(p, 'utf8'), 'utf8')
    writeFileSync(p, body + '\n', 'utf8')
    return tokens
  }

  /* ---------------- cards (open loops) ---------------- */

  cards(convId, filter = {}) {
    const dir = this.cardsDir(convId)
    if (!existsSync(dir)) return []
    const out = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue
      const card = decodeCard(readFileSync(join(dir, name), 'utf8'))
      card.id = card.id ?? name.replace(/\.md$/, '')
      // A hash mismatch means the file was edited outside the plugin: keep the
      // user's text, but surface it instead of silently overwriting later.
      if (card.body_hash && card.body_hash !== sha(card.body)) card.external_edit = true
      if (filter.phase && card.phase !== filter.phase) continue
      if (filter.phases && !filter.phases.includes(card.phase)) continue
      out.push(card)
    }
    return out.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
  }

  putCard(convId, card) {
    const title = String(card.title ?? '').trim()
    if (!title) throw new Error('card title is required')
    const body = String(card.body ?? '').trim()
    const secrets = scanSecrets(`${title}\n${body}`)
    if (secrets.length) throw new Error(`card looks sensitive (${secrets.length} pattern hit); redact it first`)

    const dir = this.cardsDir(convId)
    mkdirSync(dir, { recursive: true })
    const phase = PHASES.includes(card.phase) ? card.phase : 'planning'
    const id = card.id ?? nextId('C', dir)
    const record = {
      ...card,
      id,
      title,
      body,
      phase,
      created_at: card.created_at ?? nowIso(),
      updated_at: nowIso(),
      body_hash: sha(body),
    }
    const encoded = encodeCard(record)
    if (Buffer.byteLength(encoded, 'utf8') > MAX_CARD_BYTES) {
      throw new Error(`card is ${Buffer.byteLength(encoded, 'utf8')} bytes, over the ${MAX_CARD_BYTES} limit; split it into several cards`)
    }
    const file = join(dir, `${id}-${safeName(title)}.md`)
    writeFileSync(file, encoded, 'utf8')
    return record
  }

  /** Bring a dormant or archived card back to work. Mentioning it is enough. */
  revive(convId, cardId) {
    return this.advance(convId, cardId, 'executing')
  }

  /** Move a card along the phase machine. */
  advance(convId, cardId, phase) {
    if (!PHASES.includes(phase)) throw new Error(`unknown phase: ${phase}`)
    const card = this.cards(convId).find((c) => c.id === cardId)
    if (!card) throw new Error(`card not found: ${cardId}`)
    const record = { ...card, phase, updated_at: nowIso() }
    if (phase === 'delivered') record.delivered_at = nowIso()
    const dir = this.cardsDir(convId)
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${cardId}-`) || name === `${cardId}.md`) rmSync(join(dir, name), { force: true })
    }
    return this.putCard(convId, record)
  }

  /* ---------------- aging ---------------- */

  /**
   * Time does the work that users never do. delivered -> dormant -> archived;
   * any mention flips a card back to executing.
   */
  sweep(now = Date.now()) {
    const moved = []
    const convRoot = join(this.root, 'conv')
    if (!existsSync(convRoot)) return moved
    for (const convId of readdirSync(convRoot)) {
      for (const card of this.cards(convId)) {
        const stamp = Date.parse(card.delivered_at ?? card.updated_at ?? '') || now
        const age = daysBetween(stamp, now)
        if (card.phase === 'delivered' && age >= DORMANT_AFTER_DAYS) {
          moved.push(this.advance(convId, card.id, 'dormant'))
        } else if (card.phase === 'dormant' && age >= ARCHIVE_AFTER_DAYS) {
          moved.push(this.advance(convId, card.id, 'archived'))
        }
      }
    }
    return moved
  }

  /* ---------------- decisions (immutable) ---------------- */

  decisionPath(id) {
    const dir = this.decisionsDir
    if (!existsSync(dir)) return join(dir, `${id}.md`)
    const hit = readdirSync(dir).find((n) => n.startsWith(`${id}-`) || n === `${id}.md`)
    return hit ? join(dir, hit) : join(dir, `${id}.md`)
  }

  decisions() {
    if (!existsSync(this.decisionsDir)) return []
    return readdirSync(this.decisionsDir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => decodeCard(readFileSync(join(this.decisionsDir, n), 'utf8')))
      .map((d) => (d.body_hash && d.body_hash !== sha(d.body) ? { ...d, external_edit: true } : d))
  }

  putDecision(decision) {
    const title = String(decision.title ?? '').trim()
    if (!title) throw new Error('decision title is required')
    const body = String(decision.body ?? '').trim()
    const secrets = scanSecrets(`${title}\n${body}`)
    if (secrets.length) throw new Error(`decision looks sensitive (${secrets.length} pattern hit); redact it first`)

    mkdirSync(this.decisionsDir, { recursive: true })
    const id = decision.id ?? nextId('D', this.decisionsDir, this.decisions().map((d) => d.id))
    const record = {
      ...decision,
      id,
      title,
      body,
      status: decision.status ?? 'adopted',
      created_at: decision.created_at ?? nowIso(),
      updated_at: nowIso(),
      body_hash: sha(body),
    }
    const encoded = encodeCard(record)
    if (Buffer.byteLength(encoded, 'utf8') > MAX_CARD_BYTES) {
      throw new Error(`decision is ${Buffer.byteLength(encoded, 'utf8')} bytes, over the ${MAX_CARD_BYTES} limit; split it`)
    }
    writeFileSync(join(this.decisionsDir, `${id}-${safeName(title)}.md`), encoded, 'utf8')
    return record
  }

  /** A conclusion is never edited: a new one replaces it and the old is archived. */
  supersede(oldId, decision) {
    const old = this.decisions().find((d) => d.id === oldId)
    if (!old) throw new Error(`decision not found: ${oldId}`)
    for (const name of readdirSync(this.decisionsDir)) {
      if (name.startsWith(`${oldId}-`)) {
        mkdirSync(this.archiveDir, { recursive: true })
        renameSync(join(this.decisionsDir, name), join(this.archiveDir, name))
      }
    }
    return this.putDecision({ ...decision, supersedes: [...(old.supersedes ?? []), oldId] })
  }

  /**
   * One-time adoption of a pre-1.1 global memory directory.
   *
   * Before 1.1 every project shared one root, so `shared/` contains conclusions
   * from several projects with no field saying which. Conversation data can be
   * attributed through its session header; `shared/` cannot, so it is copied
   * wholesale and flagged in LEGACY-IMPORT.md rather than silently merged.
   *
   * The legacy directory is renamed, never deleted, so the import runs once and
   * stays reversible.
   */
  adoptLegacy(legacyRoot) {
    if (!legacyRoot || !existsSync(legacyRoot)) return null
    const marker = join(this.root, 'LEGACY-IMPORT.md')
    if (existsSync(marker)) return null

    cpSync(legacyRoot, this.root, { recursive: true, force: false, errorOnExist: false })

    const decisions = this.decisions().length
    const refs = this.refs().length
    const convRoot = join(this.root, 'conv')
    const conversations = existsSync(convRoot) ? readdirSync(convRoot).length : 0

    const stamp = new Date().toISOString()
    writeFileSync(marker, [
      '# 旧版记忆导入记录',
      '',
      `时间：${stamp}`,
      `来源：${legacyRoot}`,
      '',
      '这些数据来自 1.1 之前的全局记忆目录，当时所有项目共用一个根目录，',
      '因此 `shared/` 里的结论无法判断原本属于哪个项目。',
      '',
      '处理建议：',
      '- 属于当前项目的结论保留在 `shared/decisions/`',
      '- 属于其他项目的，用 `memory_ref` 复制过去，然后删除本地这份',
      '',
      `导入数量：结论 ${decisions} 条、引用 ${refs} 条、会话 ${conversations} 个`,
      '',
    ].join('\n'), 'utf8')

    const archived = `${legacyRoot}.migrated-${stamp.replace(/[:.]/g, '-')}`
    try {
      renameSync(legacyRoot, archived)
    } catch {
      /* if it cannot be renamed the marker still prevents a second import */
    }

    return { decisions, refs, conversations, from: legacyRoot, archived }
  }

  /* ---------------- cross-project references (read-only snapshots) ---------------- */

  refs() {
    const dir = join(this.shared, 'refs')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => decodeCard(readFileSync(join(dir, n), 'utf8')))
  }

  putRef(ref) {
    const dir = join(this.shared, 'refs')
    mkdirSync(dir, { recursive: true })
    const id = ref.id ?? nextId('R', dir, this.refs().map((r) => r.id))
    const record = { ...ref, id, status: ref.status ?? 'reference', imported_at: ref.imported_at ?? nowIso() }
    writeFileSync(join(dir, `${id}-${safeName(record.title ?? '')}.md`), encodeCard(record), 'utf8')
    return record
  }

  /**
   * Copy a conclusion out of another project. This is a fork, not a link: the
   * source keeps evolving, the snapshot does not follow. That is deliberate —
   * what suited one project may not suit this one.
   */
  importRefFrom(sourceRoot, decisionId) {
    const source = new Memory(sourceRoot)
    const hit = source.decisions().find((d) => d.id === decisionId)
    if (!hit) throw new Error(`decision not found in source project: ${decisionId}`)
    let project = sourceRoot
    try {
      project = JSON.parse(readFileSync(join(sourceRoot, 'project.json'), 'utf8')).name ?? sourceRoot
    } catch {
      /* keep the path as the label */
    }
    return this.putRef({
      title: hit.title,
      body: hit.body,
      evidence: [...(hit.evidence ?? []), `imported from ${project} / ${hit.id}`],
      source_project: project,
      source_id: hit.id,
    })
  }

  /* ---------------- delivery log ---------------- */

  logDelivery({ task, version, artifact, completeness = '全量' }) {
    const line = `${localDate()} | ${task} | ${version} | ${artifact} | ${completeness}\n`
    writeFileSync(join(this.shared, 'closed.md'), line, { encoding: 'utf8', flag: 'a' })
    return line.trim()
  }

  /* ---------------- inbox: single writer for project scope ---------------- */

  inboxDir(convId) {
    return join(this.convDir(convId), 'inbox')
  }

  /** Conversations never write shared/ directly; they drop an op here. */
  enqueue(convId, op) {
    const dir = this.inboxDir(convId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    writeFileSync(file, JSON.stringify({ at: nowIso(), ...op }), 'utf8')
    return file
  }

  pendingInbox() {
    const convRoot = join(this.root, 'conv')
    if (!existsSync(convRoot)) return 0
    let count = 0
    for (const convId of readdirSync(convRoot)) {
      const dir = this.inboxDir(convId)
      if (existsSync(dir)) count += readdirSync(dir).filter((n) => n.endsWith('.json')).length
    }
    return count
  }

  /**
   * Drain every conversation's inbox in timestamp order. This is the only code
   * path that writes project scope, so two conversations can never interleave a
   * write — and a crash mid-way leaves the remaining ops on disk for the next
   * flush instead of losing them.
   */
  flush() {
    const convRoot = join(this.root, 'conv')
    if (!existsSync(convRoot)) return { applied: 0, errors: [] }

    const lock = join(this.shared, '.writer.lock')
    if (existsSync(lock)) {
      const takenAt = Number(readFileSync(lock, 'utf8').split('\n')[1]?.replace('at=', '') ?? 0)
      if (takenAt && Date.now() - takenAt < 60000) return { applied: 0, errors: [], busy: true }
    }
    writeFileSync(lock, `pid=${process.pid}\nat=${Date.now()}`, 'utf8')

    const queue = []
    for (const convId of readdirSync(convRoot)) {
      const dir = this.inboxDir(convId)
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) if (name.endsWith('.json')) queue.push(join(dir, name))
    }
    queue.sort()

    const errors = []
    let applied = 0
    for (const file of queue) {
      try {
        const op = JSON.parse(readFileSync(file, 'utf8'))
        if (op.op === 'decision') this.putDecision(op.decision)
        else if (op.op === 'supersede') this.supersede(op.oldId, op.decision)
        else if (op.op === 'delivery') this.logDelivery(op.delivery)
        else throw new Error(`unknown inbox op: ${op.op}`)
        rmSync(file, { force: true })
        applied++
      } catch (error) {
        errors.push({ file: basename(file), message: String(error?.message ?? error) })
      }
    }
    rmSync(lock, { force: true })
    return { applied, errors }
  }

  /**
   * Human-readable snapshot at the top of the memory root. Written after every
   * turn so the plugin's state is visible by opening one file, and reused by
   * `scripts/status.mjs` so the two can never drift apart.
   */
  statusReport(convId, { layers = 1, health = 'OK', version = '?' } = {}) {
    const cards = this.cards(convId)
    const byPhase = {}
    for (const card of cards) byPhase[card.phase] = (byPhase[card.phase] ?? 0) + 1
    const phaseLine = Object.entries(byPhase).map(([phase, count]) => `${phase} ${count}`).join(' · ') || '无'
    return [
      '# 记忆状态',
      '',
      `更新：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      `插件：v${version}`,
      `层数：${layers}${layers > 1 ? `（本层 + 父级 ${layers - 1}）` : '（仅本层）'}`,
      `本会话 state：${estimateTokens(this.readState(convId))} tok`,
      `本会话卡片：${cards.length} 张（${phaseLine}）`,
      `项目结论：${this.decisions().length} 条 · 引用：${this.refs().length} 条 · 待落盘：${this.pendingInbox()}`,
      '',
      `健康：${health}`,
      '',
    ].join('\n')
  }

  writeStatus(convId, options) {
    try {
      writeFileSync(join(this.root, 'STATUS.md'), this.statusReport(convId, options), 'utf8')
      return true
    } catch {
      return false
    }
  }

  /* ---------------- manifest for injection ---------------- */

  manifest(convId, { manifestTokens = 600, extraDecisions = [] } = {}) {
    const parts = []
    const state = this.readState(convId).trim()
    if (state) parts.push(`State:\n${state}`)

    const active = this.cards(convId, { phases: ['planning', 'executing'] })
    if (active.length) {
      parts.push('Open:\n' + active.slice(0, 5).map((c) => `- [${c.id}] ${c.title} (${c.phase})`).join('\n'))
    }

    const decisions = this.decisions()
    if (decisions.length) {
      parts.push('Decisions:\n' + decisions.slice(0, 8).map((d) => `- [${d.id}] ${d.title}`).join('\n'))
    }

    if (extraDecisions.length) {
      parts.push('Shared (read-only, from a parent project):\n' + extraDecisions.slice(0, 8).map((d) => `- ${d}`).join('\n'))
    }

    const dormant = this.cards(convId, { phases: ['dormant'] }).length
    const archived = this.cards(convId, { phases: ['archived'] }).length
    if (dormant || archived) parts.push(`Dormant ${dormant} · archived ${archived}`)

    if (!parts.length) return null
    const text = parts.join('\n\n')
    return { text, tokens: Math.ceil(text.length / 2), digest: sha(text) }
  }
}

export { decodeCard, encodeCard, sha }
