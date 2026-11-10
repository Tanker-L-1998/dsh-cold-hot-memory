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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

export const PHASES = ['planning', 'executing', 'delivered', 'dormant', 'archived']
export const DORMANT_AFTER_DAYS = 30
export const ARCHIVE_AFTER_DAYS = 90

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
    const p = this.statePath(convId)
    mkdirSync(dirname(p), { recursive: true })
    if (existsSync(p)) writeFileSync(`${p}.bak`, readFileSync(p, 'utf8'), 'utf8')
    writeFileSync(p, String(text ?? '').trim() + '\n', 'utf8')
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
      if (filter.phase && card.phase !== filter.phase) continue
      if (filter.phases && !filter.phases.includes(card.phase)) continue
      out.push(card)
    }
    return out.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
  }

  putCard(convId, card) {
    const dir = this.cardsDir(convId)
    mkdirSync(dir, { recursive: true })
    const phase = PHASES.includes(card.phase) ? card.phase : 'planning'
    const id = card.id ?? nextId('C', dir)
    const record = {
      ...card,
      id,
      phase,
      created_at: card.created_at ?? nowIso(),
      updated_at: nowIso(),
    }
    const file = join(dir, `${id}-${safeName(record.title ?? '')}.md`)
    writeFileSync(file, encodeCard(record), 'utf8')
    return record
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
  }

  putDecision(decision) {
    mkdirSync(this.decisionsDir, { recursive: true })
    const id = decision.id ?? nextId('D', this.decisionsDir, this.decisions().map((d) => d.id))
    const record = { ...decision, id, status: decision.status ?? 'adopted', updated_at: nowIso() }
    writeFileSync(join(this.decisionsDir, `${id}-${safeName(record.title ?? '')}.md`), encodeCard(record), 'utf8')
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

  /* ---------------- delivery log ---------------- */

  logDelivery({ task, version, artifact, completeness = '全量' }) {
    const line = `${nowIso().slice(0, 10)} | ${task} | ${version} | ${artifact} | ${completeness}\n`
    writeFileSync(join(this.shared, 'closed.md'), line, { encoding: 'utf8', flag: 'a' })
    return line.trim()
  }

  /* ---------------- manifest for injection ---------------- */

  manifest(convId, { manifestTokens = 600 } = {}) {
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

    const dormant = this.cards(convId, { phases: ['dormant'] }).length
    const archived = this.cards(convId, { phases: ['archived'] }).length
    if (dormant || archived) parts.push(`Dormant ${dormant} · archived ${archived}`)

    if (!parts.length) return null
    const text = parts.join('\n\n')
    return { text, tokens: Math.ceil(text.length / 2), digest: sha(text) }
  }
}

export { decodeCard, encodeCard, sha }
