/**
 * dsh-cold-hot-memory — memory engine (pure, no cordis).
 *
 * Storage is an append-only JSONL log; the in-memory index is rebuilt by
 * replaying it, so there is no second source of truth that can drift.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

export const TIERS = ['hot', 'warm', 'cold']
export const STATUSES = ['active', 'stale', 'superseded', 'archived']

export const DEFAULT_LIMITS = {
  hotTokens: 2000,
  warmTokens: 8000,
  manifestTokens: 1200,
  hotRetentionDays: 7,
  warmRetentionDays: 180,
  eventLogMaxBytes: 8 * 1024 * 1024,
}

const TIER_WEIGHT = { hot: 3.0, warm: 1.5, cold: 0.0 }
const TIER_BONUS = { hot: 3.0, warm: 1.5, cold: 0.0 }

/* ------------------------------------------------------------------ *
 * Token estimation
 * The original used ceil(len/2), which badly under-counts CJK: a
 * Chinese character is ~1 token, not 0.5. Under-counting lets `hot`
 * silently blow the real context budget.
 * ------------------------------------------------------------------ */
export function estimateTokens(text) {
  let cjk = 0
  let ascii = 0
  let other = 0
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0)
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff)
    ) cjk++
    else if (cp < 128) ascii++
    else other++
  }
  return Math.max(1, Math.ceil(cjk * 1.0 + ascii / 4 + other / 2))
}

/* ------------------------------------------------------------------ *
 * Tokenization
 * The original extracted whole CJK runs with /[\u4e00-\u9fff]{2,}/, so
 * "当前目标设计" became one token and only an exact substring hit scored.
 * Bigrams restore normal Chinese recall.
 * ------------------------------------------------------------------ */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const out = new Set()
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0])
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0]
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

/* ------------------------------------------------------------------ *
 * Secret scanning (extended for Chinese labels, with a value-shaped
 * guard so "token 预算" is not a false positive).
 * ------------------------------------------------------------------ */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(?:\b(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|credential)\b|密码|口令|密钥|令牌|私钥)\s*[:=：]\s*\S{6,}/i,
  /\bAuthorization\s*:\s*Bearer\s+\S{10,}/i,
]

export function scanSecrets(text) {
  const hits = []
  for (const re of SECRET_PATTERNS) if (re.test(String(text ?? ''))) hits.push(String(re))
  return hits
}

/* ------------------------------------------------------------------ */

export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

export function nowIso() {
  return new Date().toISOString()
}

function parseTime(value) {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : t
}

function isExpired(record, at = Date.now()) {
  const t = parseTime(record.expires_at)
  return t !== null && t < at
}

/* ------------------------------------------------------------------ *
 * Scoring: BM25 over a weighted field text instead of unbounded
 * additive keyword hits. The original let one record score +5 per token
 * with no length normalization, so long records always won.
 * ------------------------------------------------------------------ */
const BM25_K1 = 1.2
const BM25_B = 0.75

function fieldText(record) {
  // title and tags are high-signal; repeat them to raise their tf.
  const title = String(record.title ?? '')
  const tags = (record.tags ?? []).join(' ')
  const scope = String(record.scope ?? '')
  const content = String(record.content ?? '')
  return `${title} ${title} ${title} ${tags} ${tags} ${scope} ${content}`
}

function buildDoc(record) {
  const tokens = tokenize(fieldText(record))
  const tf = new Map()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return { tf, length: tokens.length, record }
}

export function scoreDocs(docs, queryTokens) {
  const n = docs.length || 1
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / n || 1
  const df = new Map()
  for (const t of queryTokens) {
    let count = 0
    for (const d of docs) if (d.tf.has(t)) count++
    df.set(t, count)
  }
  const scored = []
  for (const d of docs) {
    let score = 0
    const rec = d.record
    for (const t of queryTokens) {
      const tf = d.tf.get(t)
      if (!tf) continue
      const dfT = df.get(t) ?? 0
      const idf = Math.log(1 + (n - dfT + 0.5) / (dfT + 0.5))
      const norm = 1 - BM25_B + (BM25_B * d.length) / avgLen
      score += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm)
    }
    const tier = TIER_BONUS[rec.tier] ?? 0
    const confidence = Number(rec.confidence ?? 0)
    const ageDays = Math.max(0, (Date.now() - (parseTime(rec.updated_at) ?? Date.now())) / 86400000)
    const recency = 1 / (1 + Math.log1p(ageDays) * 0.35)
    scored.push({ score: score * (1 + 0.15 * tier * 0.4 + 0.2 * confidence + 0.25 * recency) + tier, record: rec })
  }
  return scored.sort((a, b) => b.score - a.score || String(b.record.updated_at).localeCompare(String(a.record.updated_at)))
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */
export class MemoryStore {
  constructor(root, options = {}) {
    this.root = root
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
    this.records = new Map()
    this.eventsPath = join(root, 'events.jsonl')
    this.storePath = join(root, 'store.jsonl')
    this.loaded = false
  }

  ensure() {
    mkdirSync(this.root, { recursive: true })
    if (!existsSync(this.storePath)) appendFileSync(this.storePath, '', 'utf8')
  }

  load() {
    if (this.loaded) return this
    mkdirSync(this.root, { recursive: true })
    if (!existsSync(this.storePath)) {
      this.loaded = true
      return this
    }
    const raw = readFileSync(this.storePath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const op = JSON.parse(trimmed)
        if (op.op === 'put' && op.record?.id) this.records.set(op.record.id, op.record)
        else if (op.op === 'delete' && op.id) this.records.delete(op.id)
      } catch {
        /* a torn trailing line is ignored; the next write appends a new op */
      }
    }
    this.loaded = true
    return this
  }

  appendOp(op) {
    const payload = { at: nowIso(), ...op }
    appendFileSync(this.storePath, JSON.stringify(payload) + '\n', 'utf8')
    if (op.op === 'put' && op.record?.id) this.records.set(op.record.id, op.record)
    else if (op.op === 'delete' && op.id) this.records.delete(op.id)
    this.audit(op)
    return payload
  }

  audit(op) {
    try {
      const size = existsSync(this.eventsPath) ? statSync(this.eventsPath).size : 0
      if (size > this.limits.eventLogMaxBytes) {
        renameSync(this.eventsPath, `${this.eventsPath}.${Date.now()}.bak`)
      }
      const brief = op.op === 'put'
        ? { event: 'put', id: op.record.id, tier: op.record.tier, status: op.record.status }
        : { event: op.op, id: op.id ?? null }
      appendFileSync(this.eventsPath, JSON.stringify({ at: nowIso(), ...brief }) + '\n', 'utf8')
    } catch {
      /* audit must never break a write */
    }
  }

  list(filter = {}) {
    this.load()
    const at = filter.at ?? Date.now()
    let out = [...this.records.values()]
    if (!filter.includeInactive) out = out.filter((r) => r.status === 'active')
    if (filter.tier && filter.tier !== 'all') out = out.filter((r) => r.tier === filter.tier)
    if (filter.scope) out = out.filter((r) => r.scope === filter.scope)
    if (filter.tags?.length) {
      const want = new Set(filter.tags)
      out = out.filter((r) => (r.tags ?? []).some((t) => want.has(t)))
    }
    if (!filter.includeExpired) out = out.filter((r) => !isExpired(r, at))
    return out
  }

  /* ---------------- write ---------------- */
  put(input) {
    this.load()
    const id = String(input.id ?? '').trim()
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error('memory id must match [A-Za-z0-9._-]{1,80}')
    const content = String(input.content ?? '').trim()
    if (!content) throw new Error('content is required')
    const tier = input.tier ?? 'hot'
    if (!TIERS.includes(tier)) throw new Error(`tier must be one of ${TIERS.join(', ')}`)

    const secrets = scanSecrets(content)
    if (secrets.length && !input.allowSensitive) {
      throw new Error(`content looks sensitive (${secrets.length} pattern hit); redact it or pass allowSensitive explicitly`)
    }

    const hash = sha256(content)
    const duplicate = [...this.records.values()].find(
      (r) => r.hash === hash && r.status === 'active' && r.id !== id,
    )
    if (duplicate) {
      return { status: 'skipped', reason: 'duplicate', record: summarize(duplicate) }
    }

    const title = String(input.title ?? '').trim() || id
    const previous = this.records.get(id)
    const conflicts = [...this.records.values()].find(
      (r) =>
        r.id !== id &&
        r.status === 'active' &&
        r.scope === (input.scope ?? previous?.scope ?? 'project') &&
        r.title === title &&
        r.hash !== hash,
    )

    const record = {
      id,
      tier,
      title,
      scope: input.scope ?? previous?.scope ?? 'project',
      content,
      tags: [...new Set((input.tags ?? previous?.tags ?? []).map(String))],
      status: input.status ?? 'active',
      confidence: clamp01(input.confidence ?? previous?.confidence ?? 0.8),
      source_refs: [...new Set(input.sourceRefs ?? previous?.source_refs ?? [])],
      created_at: previous?.created_at ?? nowIso(),
      updated_at: nowIso(),
      expires_at: input.expiresAt ?? previous?.expires_at ?? null,
      supersedes: [...new Set(input.supersedes ?? previous?.supersedes ?? [])],
      derived_from: [...new Set(input.derivedFrom ?? previous?.derived_from ?? [])],
      conflicts_with: conflicts ? [...new Set([...(previous?.conflicts_with ?? []), conflicts.id])] : previous?.conflicts_with ?? [],
      hash,
      tokens: estimateTokens(content) + estimateTokens(title),
    }
    if (conflicts) record.conflict = true

    const demoted = []
    if (tier === 'hot') {
      // The original rejected an oversized hot record outright; the docs
      // say demote. Demote instead, oldest first.
      let hotTokens = this.list({ tier: 'hot' }).reduce((s, r) => s + (r.tokens ?? 0), 0) + record.tokens
      if (hotTokens > this.limits.hotTokens) {
        const oldest = this.list({ tier: 'hot' }).sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
        for (const r of oldest) {
          if (hotTokens <= this.limits.hotTokens) break
          const moved = { ...r, tier: 'warm', updated_at: nowIso() }
          this.appendOp({ op: 'put', record: moved, reason: 'hot-overflow' })
          hotTokens -= r.tokens ?? 0
          demoted.push(r.id)
        }
      }
    }

    this.appendOp({ op: 'put', record })
    return { status: 'written', record: summarize(record, true), demoted, conflictWith: conflicts?.id ?? null }
  }

  /* ---------------- read ---------------- */
  query(query, options = {}) {
    this.load()
    const docs = this.list(options).map(buildDoc)
    const qTokens = tokenize(query)
    if (!qTokens.length) {
      return docs
        .map((d) => d.record)
        .sort((a, b) => (TIER_WEIGHT[b.tier] ?? 0) - (TIER_WEIGHT[a.tier] ?? 0) || String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, options.limit ?? 8)
        .map((r) => summarize(r, { withContent: true, maxChars: options.maxChars ?? 1200 }))
    }
    return scoreDocs(docs, qTokens)
      .slice(0, options.limit ?? 8)
      .map(({ score, record }) => ({ ...summarize(record, { withContent: true, maxChars: options.maxChars ?? 1200 }), score: round(score) }))
  }

  stats() {
    this.load()
    const all = [...this.records.values()]
    const byTier = Object.fromEntries(TIERS.map((t) => [t, 0]))
    const tokensByTier = Object.fromEntries(TIERS.map((t) => [t, 0]))
    const statuses = {}
    for (const r of all) {
      if (byTier[r.tier] !== undefined) {
        byTier[r.tier]++
        tokensByTier[r.tier] += r.tokens ?? 0
      }
      statuses[r.status] = (statuses[r.status] ?? 0) + 1
    }
    return {
      root: this.root,
      total: all.length,
      byTier,
      tokensByTier,
      statuses,
      expired: all.filter((r) => isExpired(r)).length,
      conflicts: all.filter((r) => r.conflict).length,
      limits: this.limits,
      warnings: [
        ...(tokensByTier.hot > this.limits.hotTokens ? ['hot exceeds hotTokens budget'] : []),
        ...(tokensByTier.warm > this.limits.warmTokens ? ['warm exceeds warmTokens budget'] : []),
      ],
    }
  }

  /* ---------------- lifecycle ---------------- */
  promote(id, tier) {
    this.load()
    const r = this.records.get(id)
    if (!r) throw new Error(`memory not found: ${id}`)
    if (!TIERS.includes(tier)) throw new Error(`tier must be one of ${TIERS.join(', ')}`)
    const next = { ...r, tier, updated_at: nowIso() }
    this.appendOp({ op: 'put', record: next, reason: 'promote' })
    return summarize(next)
  }

  forget(id) {
    this.load()
    const r = this.records.get(id)
    if (!r) throw new Error(`memory not found: ${id}`)
    // The original set only the registry entry to cold, leaving the record
    // file saying hot/warm — a drift verify could not detect.
    const next = { ...r, tier: 'cold', status: 'archived', updated_at: nowIso() }
    this.appendOp({ op: 'put', record: next, reason: 'archive' })
    return summarize(next)
  }

  /** Age-based demotion the original declared in config but never ran. */
  sweep(at = Date.now()) {
    this.load()
    const moved = []
    for (const r of [...this.records.values()]) {
      if (r.status !== 'active') continue
      const ageDays = (at - (parseTime(r.updated_at) ?? at)) / 86400000
      if (r.tier === 'hot' && ageDays > this.limits.hotRetentionDays) {
        moved.push(this.promote(r.id, 'warm'))
      } else if (r.tier === 'warm' && ageDays > this.limits.warmRetentionDays) {
        moved.push(this.promote(r.id, 'cold'))
      } else if (isExpired(r, at)) {
        moved.push(this.forget(r.id))
      }
    }
    return moved
  }

  /** Compact append-only log so it does not grow without bound. */
  compact() {
    this.load()
    const lines = [...this.records.values()].map((r) => JSON.stringify({ at: nowIso(), op: 'put', record: r }))
    const tmp = `${this.storePath}.${process.pid}.tmp`
    appendFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
    renameSync(tmp, this.storePath)
    return { records: lines.length }
  }

  /** The manifest injected into the model's context. */
  manifest(options = {}) {
    this.load()
    const budget = options.manifestTokens ?? this.limits.manifestTokens
    const scope = options.scope || undefined
    const hot = this.list({ tier: 'hot', scope }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    const warm = this.list({ tier: 'warm', scope }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    const coldCount = this.list({ tier: 'cold', scope, includeExpired: true }).length
    const lines = []
    let used = 0
    const push = (line) => {
      const cost = estimateTokens(line)
      if (used + cost > budget) return false
      lines.push(line)
      used += cost
      return true
    }
    push('Hot (current task state):')
    for (const r of hot) {
      const text = `- [${r.id}] ${r.title}: ${truncate(r.content, 240)}`
      if (!push(text)) break
    }
    if (warm.length) push('Warm (reusable knowledge, titles only — call memory_query for detail):')
    for (const r of warm) {
      const text = `- [${r.id}] ${r.title}${r.tags?.length ? ` (${r.tags.join(',')})` : ''}`
      if (!push(text)) break
    }
    if (coldCount) push(`Cold: ${coldCount} archived records (retrieve with memory_query).`)
    if (!lines.length) return null
    const text = lines.join('\n')
    return { text, tokens: used, digest: sha256(text) }
  }
}

/* ------------------------------------------------------------------ */

function clamp01(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.8
}

function round(v) {
  return Math.round(v * 1000) / 1000
}

function truncate(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

export function summarize(record, { withContent = false, maxChars = 1200 } = {}) {
  const out = {
    id: record.id,
    tier: record.tier,
    title: record.title,
    scope: record.scope,
    tags: record.tags,
    status: record.status,
    confidence: record.confidence,
    source_refs: record.source_refs,
    updated_at: record.updated_at,
    expires_at: record.expires_at,
    tokens: record.tokens,
  }
  if (record.conflict) out.conflict = true
  if (record.conflicts_with?.length) out.conflicts_with = record.conflicts_with
  if (withContent) {
    const text = String(record.content ?? '')
    out.content = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
    if (text.length > maxChars) out.content_truncated = true
  }
  return out
}
