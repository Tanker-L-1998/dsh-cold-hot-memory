/**
 * dsh-cold-hot-memory — host plugin (v0.3, three-file model).
 *
 * Tools:
 *   memory_state     read / overwrite the current state
 *   memory_card      open or advance an open-loop card
 *   memory_decision  record or supersede a conclusion
 *   memory_recall    search cards and conclusions
 *   memory_stats     counts and budget
 *
 * Injection: at the start of each turn a short manifest (state + open cards +
 * conclusion titles) is prepended, and skipped when its digest is unchanged.
 *
 * No third-party imports at module scope: a missing peer must not kill the
 * module before it can report why.
 */
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Memory, PHASES } from './store.js'
import { estimateTokens, tokenize } from './engine.js'

export const name = 'cold-hot-memory'
export const inject = ['tools']

const DEFAULTS = {
  root: '',
  injectManifest: true,
  manifestTokens: 600,
}

function heartbeat(phase) {
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.runtime')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'loaded.log'), `${new Date().toISOString()}\t${phase}\n`, 'utf8')
  } catch {
    /* heartbeat must never break loading */
  }
}
heartbeat('module-imported')

const text = (value) => [{ type: 'text', text: value }]

/** Session id → a short, path-safe conversation key. */
function conversationKey(session) {
  const raw = session?.header?.id ?? session?.id ?? session?.sessionId
  const safe = String(raw ?? '').replace(/[^A-Za-z0-9_-]/g, '')
  return safe ? `c-${safe.slice(0, 12)}` : 'c-unknown'
}

/**
 * Todo integration is detected lazily: it may not be registered when we load,
 * and agent-scoped tools need the calling agent as the scope. The probe leaves a
 * note so `memory_stats` can show why it chose linked or standalone.
 */
let todoProbe = { mode: 'standalone', note: 'not probed' }
function detectTodoMode(ctx, agent) {
  if (todoProbe.mode === 'linked') return 'linked'
  const tools = ctx?.tools
  if (!tools) {
    todoProbe = { mode: 'standalone', note: 'no ctx.tools' }
    return 'standalone'
  }
  const notes = []
  for (const scope of [agent, undefined]) {
    try {
      if (typeof tools.get === 'function' && tools.get('todo_write', scope)) {
        todoProbe = { mode: 'linked', note: scope ? 'tools.get(agent)' : 'tools.get()' }
        return 'linked'
      }
    } catch (error) {
      notes.push(`get threw: ${error?.message ?? error}`)
    }
    try {
      if (typeof tools.schemas === 'function') {
        const list = tools.schemas(scope)
        const names = Array.isArray(list) ? list.map((s) => s?.name ?? s?.function?.name).filter(Boolean) : []
        if (names.includes('todo_write')) {
          todoProbe = { mode: 'linked', note: `schemas(${scope ? 'agent' : 'global'})` }
          return 'linked'
        }
        notes.push(`schemas(${scope ? 'agent' : 'global'}):${names.length}`)
      }
    } catch (error) {
      notes.push(`schemas threw: ${error?.message ?? error}`)
    }
  }
  todoProbe = { mode: 'standalone', note: notes.join(' | ') || 'no probe succeeded' }
  return 'standalone'
}

/** Cheap keyword score over title + body, reusing the CJK-aware tokenizer. */
function score(textParts, queryTokens) {
  const haystack = tokenize(textParts.join(' '))
  const bag = new Set(haystack)
  let hits = 0
  for (const token of queryTokens) if (bag.has(token)) hits++
  return hits
}

/** Tool outputs must be lossless JSON: drop undefined instead of emitting it. */
function compact(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

export async function apply(ctx, config) {
  heartbeat('apply-start')

  let defineTool
  let createUserMessage
  try {
    ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
    heartbeat('imported-dsh-tools')
    ;({ createUserMessage } = await import('@deepseek-ai/dsh-llm'))
    heartbeat('imported-dsh-llm')
  } catch (error) {
    heartbeat(`import-failed: ${error?.code ?? ''} ${error?.message ?? error}`)
    throw error
  }

  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  /**
   * One memory root per project, so conclusions never mix across projects.
   * The project path comes from the session header; without one (headless runs
   * with no cwd) fall back to the shared default.
   */
  const stores = new Map()
  function storeFor(session) {
    const cwd = session?.header?.cwd
    const root = cfg.root?.trim() ? cfg.root.trim() : cwd ? join(cwd, '.dsh-memory') : join(homedir(), '.dsh', 'memory')
    let opened = stores.get(root)
    if (!opened) {
      opened = new Memory(root).ensure(cwd ? basename(cwd) : 'memory-project')
      stores.set(root, opened)
    }
    return opened
  }
  const injected = new WeakMap()

  /* ------------------------------ state ------------------------------ */

  ctx.tools.register(defineTool({
    name: 'memory_state',
    description:
      'Read or overwrite what this conversation is doing right now. Keep it to one screen: ' +
      'current goal, progress, blocker, next step. The previous version is kept as state.md.bak.',
    parameters: {
      text: { type: 'string', description: 'New state text. Omit to read the current state.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => text(value.state ? value.state : '(state is empty)'),
    },
    async execute(args, exec) {
      const conv = conversationKey(exec.agent?.session)
      const store = storeFor(exec.agent?.session)
      if (typeof args.text === 'string' && args.text.trim()) {
        store.writeState(conv, args.text)
        return { written: true, tokens: estimateTokens(args.text), state: store.readState(conv) }
      }
      const state = store.readState(conv)
      return { written: false, tokens: estimateTokens(state), state }
    },
  }))

  /* ------------------------------ cards ------------------------------ */

  ctx.tools.register(defineTool({
    name: 'memory_card',
    description:
      'Open loops: things not finished yet. action=open creates a card, action=advance moves it ' +
      'through planning -> executing -> delivered -> dormant -> archived, action=list shows cards. ' +
      'A delivered card ages to dormant after 30 days and archived after 90; any mention revives it.',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'advance', 'list', 'promote'], description: 'What to do. promote turns pending todo items into cards when a task is shelved.' },
      items: { type: 'array', items: { type: 'string' }, description: 'For promote: the pending todo lines to shelve as cards.' },
      id: { type: 'string', description: 'Card id, required for advance.' },
      title: { type: 'string', description: 'Short title, required for open.' },
      body: { type: 'string', description: 'Details. A useful card answers: goal, progress, blocker, next step, pointer.' },
      goal: { type: 'string', description: 'What must be achieved.' },
      blocker: { type: 'string', description: 'What is in the way.' },
      nextStep: { type: 'string', description: 'The single next action.' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Pointers: seq range, file paths.' },
      vetoes: { type: 'array', items: { type: 'string' }, description: 'Approaches already rejected, and why.' },
      phase: { type: 'string', enum: [...PHASES], description: 'Target phase for advance.' },
      phases: { type: 'array', items: { type: 'string' }, description: 'Filter for list.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        if (Array.isArray(value.promoted)) {
          return text(value.promoted.length ? `Promoted ${value.promoted.length} card(s): ${value.promoted.join(', ')}` : 'Nothing to promote.')
        }
        if (Array.isArray(value.cards)) {
          return text(value.cards.length ? value.cards.map((c) => `[${c.id}] ${c.title} (${c.phase})`).join('\n') : 'No cards.')
        }
        return text(`Card ${value.id} → ${value.phase}`)
      },
    },
    async execute(args, exec) {
      const conv = conversationKey(exec.agent?.session)
      const store = storeFor(exec.agent?.session)
      if (args.action === 'open') {
        const card = store.putCard(conv, {
          title: args.title,
          body: args.body,
          goal: args.goal,
          blocker: args.blocker,
          next_step: args.nextStep,
          evidence: args.evidence,
          vetoes: args.vetoes,
          phase: args.phase ?? 'planning',
        })
        return compact({ id: card.id, phase: card.phase, title: card.title })
      }
      if (args.action === 'advance') {
        const card = store.advance(conv, args.id, args.phase)
        if (card.phase === 'delivered') {
          // Project scope is written only by the inbox flusher.
          store.enqueue(conv, { op: 'delivery', delivery: { task: card.title, version: 'v1', artifact: (card.evidence ?? []).join(' ') || '-' } })
          store.flush()
        }
        return compact({ id: card.id, phase: card.phase })
      }
      if (args.action === 'promote') {
        const items = (args.items ?? []).filter((x) => String(x ?? '').trim())
        const created = items.map((item) => store.putCard(conv, { title: String(item).slice(0, 60), body: String(item), phase: 'dormant' }))
        return compact({ promoted: created.map((c) => c.id), count: created.length })
      }
      return { cards: store.cards(conv, args.phases?.length ? { phases: args.phases } : {}) }
    },
  }))

  /* ---------------------------- decisions ---------------------------- */

  ctx.tools.register(defineTool({
    name: 'memory_decision',
    description:
      'Conclusions are immutable: to change one, supersede it — the old version is archived and ' +
      'the new one records what it replaced. Include evidence, and the reasons for approaches you rejected.',
    parameters: {
      action: { type: 'string', required: true, enum: ['put', 'supersede', 'list'], description: 'What to do.' },
      id: { type: 'string', description: 'Decision id, required for supersede.' },
      title: { type: 'string', description: 'One line stating the conclusion.' },
      body: { type: 'string', description: 'Why, constraints, trade-offs.' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Where it came from.' },
      vetoes: { type: 'array', items: { type: 'string' }, description: 'Rejected alternatives and the reason.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        if (Array.isArray(value.decisions)) {
          return text(value.decisions.length ? value.decisions.map((d) => `[${d.id}] ${d.title}`).join('\n') : 'No conclusions yet.')
        }
        return text(`Conclusion ${value.id} recorded${value.supersedes ? `, superseding ${value.supersedes}` : ''}.`)
      },
    },
    async execute(args, exec) {
      const conv = conversationKey(exec.agent?.session)
      const store = storeFor(exec.agent?.session)
      if (args.action === 'list') return { decisions: store.decisions().map((d) => compact({ id: d.id, title: d.title, status: d.status })) }

      const payload = { title: args.title, body: args.body, evidence: args.evidence, vetoes: args.vetoes }
      store.enqueue(conv, { op: args.action === 'put' ? 'decision' : 'supersede', oldId: args.id, decision: payload })
      const flushed = store.flush()
      const hit = store.decisions().find((d) => d.title === payload.title)
      return compact({
        id: hit?.id,
        title: payload.title,
        supersedes: args.action === 'supersede' ? args.id : undefined,
        queued: hit ? undefined : true,
        busy: flushed.busy ? true : undefined,
        errors: flushed.errors?.length ? flushed.errors : undefined,
      })
    },
  }))

  /* ------------------------------ recall ----------------------------- */

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Search open-loop cards and conclusions. Cards come from this conversation; conclusions are ' +
      'project-wide, so a new conversation can learn what was already decided.',
    parameters: {
      query: { type: 'string', description: 'Keywords. Empty returns everything, newest first.' },
      limit: { type: 'integer', description: 'Max results (default 8).' },
      includeArchived: { type: 'boolean', description: 'Also search dormant and archived cards.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        const head = value.revived?.length ? `Revived: ${value.revived.join(', ')}\n\n` : ''
        const body = value.count === 0
          ? 'Nothing matched.'
          : value.results.map((r) => `[${r.id}] (${r.kind}/${r.phase ?? r.status}) ${r.title}\n${r.body ?? ''}`).join('\n---\n')
        return text(head + body)
      },
    },
    async execute(args, exec) {
      const conv = conversationKey(exec.agent?.session)
      const store = storeFor(exec.agent?.session)
      const queryTokens = tokenize(args.query ?? '')
      // Mentioning something is enough to wake it: search dormant cards too,
      // archived ones only on request.
      const phases = args.includeArchived
        ? undefined
        : queryTokens.length
          ? ['planning', 'executing', 'delivered', 'dormant']
          : ['planning', 'executing', 'delivered']
      const cards = store.cards(conv, phases ? { phases } : {}).map((c) => ({ ...c, kind: 'card' }))
      const decisions = store.decisions().map((d) => ({ ...d, kind: 'decision' }))
      const refs = store.refs().map((r) => ({ ...r, kind: 'ref' }))
      const all = [...cards, ...decisions, ...refs]

      const ranked = queryTokens.length
        ? all
            .map((item) => ({ item, score: score([item.title ?? '', item.body ?? ''], queryTokens) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
        : all.map((item) => ({ item, score: 0 }))

      const revived = []
      for (const { item, score: hit } of ranked) {
        if (revived.length >= 3) break
        if (item.kind === 'card' && hit > 0 && (item.phase === 'dormant' || item.phase === 'archived')) {
          try {
            store.revive(conv, item.id)
            revived.push(item.id)
          } catch {
            /* a card that cannot be revived is not worth failing the search */
          }
        }
      }

      const results = ranked.slice(0, Math.min(Math.max(args.limit ?? 8, 1), 30)).map(({ item }) => compact({
        id: item.id,
        kind: item.kind,
        phase: item.phase,
        status: item.status,
        title: item.title,
        body: String(item.body ?? '').slice(0, 1200),
        external_edit: item.external_edit,
      }))
      return compact({ count: results.length, results, revived: revived.length ? revived : undefined })
    },
  }))

  /* ------------------------------ stats ------------------------------ */

  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: 'Counts of cards per phase, conclusions, and how large the injected manifest is. sweep=true applies time-based aging first.',
    parameters: {
      sweep: { type: 'boolean', description: 'Run the 30/90 day aging pass before reporting.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => text(
        `cards: ${value.totalCards} | ` +
        Object.entries(value.byPhase).map(([k, v]) => `${k} ${v}`).join(' · ') +
        ` | conclusions: ${value.decisions} | refs: ${value.refs} | manifest ~${value.manifestTokens} tok` +
        ` | todo: ${value.todoMode}${value.todoMode === 'standalone' && value.todoNote ? ` (${value.todoNote})` : ''}` +
        (value.pendingInbox ? ` | inbox pending ${value.pendingInbox}` : '') +
        (value.swept ? ` | swept ${value.swept}` : ''),
      ),
    },
    async execute(args, exec) {
      const conv = conversationKey(exec.agent?.session)
      const store = storeFor(exec.agent?.session)
      const flushed = store.flush()
      const swept = args.sweep ? store.sweep().length : 0
      const cards = store.cards(conv)
      const byPhase = Object.fromEntries(PHASES.map((p) => [p, cards.filter((c) => c.phase === p).length]))
      const manifest = store.manifest(conv, { manifestTokens: cfg.manifestTokens })
      return compact({
        totalCards: cards.length,
        byPhase,
        decisions: store.decisions().length,
        refs: store.refs().length,
        manifestTokens: manifest?.tokens ?? 0,
        swept,
        todoMode: detectTodoMode(ctx, exec.agent),
        todoNote: todoProbe.note,
        pendingInbox: store.pendingInbox(),
        inboxApplied: flushed.applied || undefined,
      })
    },
  }))

  /* ------------------------------- refs ------------------------------ */

  ctx.tools.register(defineTool({
    name: 'memory_ref',
    description:
      'Read-only snapshots of conclusions from other projects. Importing is a one-time fork: ' +
      'the source may keep changing and this copy will not follow, because what suited that ' +
      'project may not suit this one. Keep the provenance line it adds.',
    parameters: {
      action: { type: 'string', required: true, enum: ['import', 'list'], description: 'What to do.' },
      from: { type: 'string', description: 'Absolute path of the other project memory root, for import.' },
      id: { type: 'string', description: 'Decision id inside that project, for import.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        if (Array.isArray(value.refs)) {
          return text(value.refs.length ? value.refs.map((r) => `[${r.id}] ${r.title} ← ${r.source}`).join('\n') : 'No references yet.')
        }
        return text(`Imported ${value.id}: ${value.title} ← ${value.source}`)
      },
    },
    async execute(args, exec) {
      const store = storeFor(exec.agent?.session)
      if (args.action === 'list') {
        return { refs: store.refs().map((r) => compact({ id: r.id, title: r.title, source: r.source_project })) }
      }
      if (!args.from || !args.id) throw new Error('import needs both "from" (project memory root) and "id" (decision id)')
      const ref = store.importRefFrom(args.from, args.id)
      return compact({ id: ref.id, title: ref.title, source: ref.source_project })
    },
  }))

  heartbeat('tools-registered')

  /* ---------------------------- injection ---------------------------- */

  if (cfg.injectManifest === false) return

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (step !== 1) return decision
    signal.throwIfAborted()

    const conv = conversationKey(agent?.session)
    const store = storeFor(agent?.session)
    const manifest = store.manifest(conv, { manifestTokens: cfg.manifestTokens })
    if (!manifest) return decision

    if (injected.get(agent.session) === manifest.digest) return decision
    if (decision.messages.some((m) => m.source?.kind === 'cold-hot-memory' && m.source?.digest === manifest.digest)) {
      injected.set(agent.session, manifest.digest)
      return decision
    }

    injected.set(agent.session, manifest.digest)
    const message = createUserMessage({
      content: text(
        '<memory-manifest>\n' +
          'Project memory below. Treat it as background index, not as source of truth; ' +
          'call memory_recall before relying on a detail.\n\n' +
          manifest.text +
          '\n</memory-manifest>',
      ),
      source: { kind: 'cold-hot-memory', digest: manifest.digest },
    })
    return { ...decision, messages: [...decision.messages, message] }
  })
}

export { estimateTokens }
