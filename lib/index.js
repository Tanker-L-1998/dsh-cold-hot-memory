/**
 * dsh-cold-hot-memory — host plugin.
 *
 * Registers memory_read / memory_write / memory_query / memory_stats /
 * memory_forget / memory_promote on `ctx.tools`, and injects a compact
 * hot+warm manifest into the step's message batch at the start of each
 * turn (`agent/pre-step`), reusing the same inbox/decision seam the
 * workspace-instructions plugin uses.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryStore, TIERS, estimateTokens, summarize } from './engine.js'

export const name = 'cold-hot-memory'
export const inject = ['tools']

export const Config = z.object({
  /** Memory root. Empty means `<home>/.dsh/memory`. */
  root: z.string().default(''),
  /** Inject the hot+warm manifest at the start of each turn. */
  injectManifest: z.boolean().default(true),
  /** Token ceiling for the injected manifest. */
  manifestTokens: z.number().default(1200),
  /** Scope recorded when a write omits one. */
  defaultScope: z.string().default('global'),
  /** Only inject records of this scope; empty means all scopes. */
  injectScope: z.string().default(''),
  hotTokens: z.number().default(2000),
  warmTokens: z.number().default(8000),
  hotRetentionDays: z.number().default(7),
  warmRetentionDays: z.number().default(180),
})

const text = (value) => [{ type: 'text', text: value }]

export function apply(ctx, config) {
  const limits = {
    hotTokens: config.hotTokens,
    warmTokens: config.warmTokens,
    manifestTokens: config.manifestTokens,
    hotRetentionDays: config.hotRetentionDays,
    warmRetentionDays: config.warmRetentionDays,
  }
  const root = config.root?.trim() ? config.root.trim() : join(homedir(), '.dsh', 'memory')
  const store = new MemoryStore(root, { limits })
  /** Last manifest digest injected per session, so unchanged memory never re-injects. */
  const injected = new WeakMap()

  /* ---------------------------- tools ---------------------------- */

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description:
      'Write one memory record. Tiers: hot = current task state (small, expires fast), ' +
      'warm = reusable project knowledge, cold = archived evidence. ' +
      'Writing an existing id updates it in place; identical content is skipped as a duplicate. ' +
      'Never store credentials — sensitive-looking content is rejected unless allowSensitive is set.',
    parameters: {
      id: { type: 'string', required: true, description: 'Stable ASCII id, e.g. MEM-042.' },
      tier: { type: 'string', required: true, enum: [...TIERS], description: 'hot | warm | cold.' },
      title: { type: 'string', required: true, description: 'Short retrieval title.' },
      content: { type: 'string', required: true, description: 'The memory body. Keep it minimal and factual.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Retrieval tags.' },
      scope: { type: 'string', description: 'Project or scope name.' },
      confidence: { type: 'number', description: '0..1 confidence. Inferences must stay below 0.7.' },
      sourceRefs: { type: 'array', items: { type: 'string' }, description: 'Where this came from, e.g. file:line or turn id.' },
      expiresAt: { type: 'string', description: 'ISO-8601 expiry, or omit for none.' },
      allowSensitive: { type: 'boolean', description: 'Explicitly allow content that looks sensitive.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          id: { type: 'string' },
          tier: { type: 'string' },
          tokens: { type: 'integer' },
          demoted: { type: 'array', items: { type: 'string' } },
          conflictWith: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => text(
        value.status === 'skipped'
          ? `Skipped: identical content already stored as ${value.id}.`
          : `Stored ${value.id} in ${value.tier} (~${value.tokens} tokens)` +
            (value.demoted?.length ? `; demoted to warm: ${value.demoted.join(', ')}` : '') +
            (value.conflictWith ? `; conflicts with ${value.conflictWith} (both kept)` : '') + '.',
      ),
    },
    async execute(args) {
      const result = store.put({
        id: args.id,
        tier: args.tier,
        title: args.title,
        content: args.content,
        tags: args.tags,
        scope: args.scope ?? config.defaultScope,
        confidence: args.confidence,
        sourceRefs: args.sourceRefs,
        expiresAt: args.expiresAt,
        allowSensitive: args.allowSensitive,
      })
      return {
        status: result.status,
        id: result.record.id,
        tier: result.record.tier,
        tokens: result.record.tokens,
        demoted: result.demoted ?? [],
        ...(result.conflictWith ? { conflictWith: result.conflictWith } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_query',
    description:
      'Search memories by keyword. Ranks with BM25 over title/tags/scope/content, weighted by tier, ' +
      'confidence and recency. Expired and inactive records are excluded unless asked for.',
    parameters: {
      query: { type: 'string', description: 'Keywords. Empty returns the highest-priority records.' },
      tier: { type: 'string', enum: ['all', ...TIERS], description: 'Restrict to one tier.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Require any of these tags.' },
      scope: { type: 'string', description: 'Restrict to one scope.' },
      limit: { type: 'integer', description: 'Max results (default 8).' },
      maxChars: { type: 'integer', description: 'Max content chars per result (default 1200).' },
      includeInactive: { type: 'boolean', description: 'Include non-active records.' },
      includeExpired: { type: 'boolean', description: 'Include expired records.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string', required: true },
                tier: { type: 'string', required: true },
                title: { type: 'string', required: true },
                content: { type: 'string' },
                score: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => text(
        value.count === 0
          ? 'No memory matched.'
          : value.results.map((r) => `[${r.id}] (${r.tier}) ${r.title}\n${r.content ?? ''}`).join('\n---\n'),
      ),
    },
    async execute(args) {
      const results = store.query(args.query ?? '', {
        tier: args.tier ?? 'all',
        tags: args.tags,
        scope: args.scope,
        limit: Math.min(Math.max(args.limit ?? 8, 1), 50),
        maxChars: Math.min(Math.max(args.maxChars ?? 1200, 80), 20000),
        includeInactive: args.includeInactive,
        includeExpired: args.includeExpired,
      })
      return { count: results.length, results }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: 'Report memory counts, token usage per tier, expiry, conflicts and budget warnings. sweep=true also applies age-based demotion and expiry.',
    parameters: {
      sweep: { type: 'boolean', description: 'Run retention sweep (hot→warm→cold→archive) before reporting.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => text(
        `total ${value.total} | hot ${value.byTier.hot} (${value.tokensByTier.hot} tok) | ` +
        `warm ${value.byTier.warm} (${value.tokensByTier.warm} tok) | cold ${value.byTier.cold} | ` +
        `expired ${value.expired} | conflicts ${value.conflicts}` +
        (value.swept?.length ? ` | swept ${value.swept.length}` : '') +
        (value.warnings.length ? ` | WARN: ${value.warnings.join('; ')}` : ''),
      ),
    },
    async execute(args) {
      const swept = args.sweep ? store.sweep() : []
      return { ...store.stats(), swept }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_promote',
    description: 'Move a memory between tiers (hot/warm/cold) without rewriting its content.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id.' },
      tier: { type: 'string', required: true, enum: [...TIERS], description: 'Target tier.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => text(`Moved ${value.id} to ${value.tier}.`),
    },
    async execute(args) {
      return store.promote(args.id, args.tier)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Archive a memory: mark it cold/archived so it stops being injected, while keeping it retrievable.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => text(`Archived ${value.id}.`),
    },
    async execute(args) {
      return store.forget(args.id)
    },
  }))

  /* -------------------------- injection -------------------------- */

  if (!config.injectManifest) return

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    // Only at the start of a turn: mid-turn injection would churn the cache.
    if (step !== 1) return decision
    signal.throwIfAborted()

    const manifest = store.manifest({
      manifestTokens: config.manifestTokens,
      scope: config.injectScope || undefined,
    })
    if (!manifest) return decision

    const previous = injected.get(agent.session)
    if (previous === manifest.digest) return decision
    if (decision.messages.some((m) => m.source?.kind === 'cold-hot-memory' && m.source?.digest === manifest.digest)) {
      injected.set(agent.session, manifest.digest)
      return decision
    }

    injected.set(agent.session, manifest.digest)
    const message = createUserMessage({
      content: text(
        '<memory-manifest>\n' +
          'The following project memory is available. Treat it as background index, not as source of truth; ' +
          'call memory_query for full content before relying on a detail.\n\n' +
          manifest.text +
          '\n</memory-manifest>',
      ),
      source: { kind: 'cold-hot-memory', digest: manifest.digest },
    })
    return { ...decision, messages: [...decision.messages, message] }
  })
}

export { estimateTokens, summarize }
