/**
 * One-off migration: v0.1 hot/warm/cold records -> v0.3 three-file layout.
 *
 * Old records live in <root>/store.jsonl with a `tier` field. New layout keeps
 * conclusions in shared/decisions. Every old record becomes a conclusion, since
 * that is the closest equivalent; the original id is kept as evidence.
 *
 * The old log is renamed to store.jsonl.migrated so it is never replayed twice.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Memory } from '../lib/store.js'

const root = process.argv[2] ?? join(homedir(), '.dsh', 'memory')
const logPath = join(root, 'store.jsonl')

if (!existsSync(logPath)) {
  console.log('nothing to migrate:', logPath)
  process.exit(0)
}

const store = new Memory(root).ensure('dsh-memory-plugin')
const records = new Map()
for (const line of readFileSync(logPath, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    const op = JSON.parse(line)
    if (op.op === 'put' && op.record?.id) records.set(op.record.id, op.record)
  } catch {
    /* skip a torn line */
  }
}

const existing = new Set(store.decisions().map((d) => d.title))
let migrated = 0
for (const record of records.values()) {
  const title = String(record.title ?? record.id)
  if (existing.has(title)) {
    console.log('skip (already present):', title)
    continue
  }
  store.putDecision({
    title,
    body: String(record.content ?? ''),
    evidence: [
      `migrated from legacy ${record.id} (tier=${record.tier}, status=${record.status})`,
      ...(record.source_refs ?? []),
    ],
    vetoes: [],
    status: record.status === 'archived' ? 'archived' : 'adopted',
  })
  migrated++
}

renameSync(logPath, `${logPath}.migrated`)
console.log(`migrated ${migrated} record(s) from ${records.size}; old log renamed to store.jsonl.migrated`)
