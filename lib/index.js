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
import { dirname, join } from 'node:path'
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
  const root = cfg.root?.trim() ? cfg.root.trim() : join(homedir(), '.dsh', 'memory')
  const store = new Memory(root).ensure()
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
      action: { type: 'string', required: true, enum: ['open', 'advance', 'list'], description: 'What to do.' },
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
        if (Array.isArray(value.cards)) {
          return text(value.cards.length ? value.cards.map((c) => `[${c.id}] ${c.title} (${c.phase})`).join('\n') : 'No cards.')
        }
        return text(`Card ${value.id} → ${value.phase}`)
      },
    },
    async execute(args, exec) {
      const conv = conversationKey(exec.agent?.session)
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
          store.logDelivery({ task: card.title, version: 'v1', artifact: (card.evidence ?? []).join(' ') || '-' })
        }
        return compact({ id: card.id, phase: card.phase })
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
    async execute(args) {
      if (args.action === 'put') {
        const d = store.putDecision({ title: args.title, body: args.body, evidence: args.evidence, vetoes: args.vetoes })
        return compact({ id: d.id, title: d.title })
      }
      if (args.action === 'supersede') {
        const d = store.supersede(args.id, { title: args.title, body: args.body, evidence: args.evidence, vetoes: args.vetoes })
        return compact({ id: d.id, title: d.title, supersedes: args.id })
      }
      return { decisions: store.decisions() }
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
      render: (_args, value) => text(
        value.count === 0
          ? 'Nothing matched.'
          : value.results.map((r) => `[${r.id}] (${r.kind}/${r.phase ?? r.status}) ${r.title}\n${r.body ?? ''}`).join('\n---\n'),
      ),
    },
    async execute(args, exec) {
      const conv = conversationKey(exec.agent?.session)
      const phases = args.includeArchived ? undefined : ['planning', 'executing', 'delivered']
      const cards = store.cards(conv, phases ? { phases } : {}).map((c) => ({ ...c, kind: 'card' }))
      const decisions = store.decisions().map((d) => ({ ...d, kind: 'decision' }))
      const all = [...cards, ...decisions]

      const queryTokens = tokenize(args.query ?? '')
      const ranked = queryTokens.length
        ? all
            .map((item) => ({ item, score: score([item.title ?? '', item.body ?? ''], queryTokens) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
        : all.map((item) => ({ item, score: 0 }))

      const results = ranked.slice(0, Math.min(Math.max(args.limit ?? 8, 1), 30)).map(({ item }) => compact({
        id: item.id,
        kind: item.kind,
        phase: item.phase,
        status: item.status,
        title: item.title,
        body: String(item.body ?? '').slice(0, 1200),
      }))
      return { count: results.length, results }
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
        ` | conclusions: ${value.decisions} | manifest ~${value.manifestTokens} tok` +
        (value.swept ? ` | swept ${value.swept}` : ''),
      ),
    },
    async execute(args, exec) {
      const conv = conversationKey(exec.agent?.session)
      const swept = args.sweep ? store.sweep().length : 0
      const cards = store.cards(conv)
      const byPhase = Object.fromEntries(PHASES.map((p) => [p, cards.filter((c) => c.phase === p).length]))
      const manifest = store.manifest(conv, { manifestTokens: cfg.manifestTokens })
      return {
        totalCards: cards.length,
        byPhase,
        decisions: store.decisions().length,
        manifestTokens: manifest?.tokens ?? 0,
        swept,
      }
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
