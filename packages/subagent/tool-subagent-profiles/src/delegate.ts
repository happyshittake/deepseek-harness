/** Native delegation orchestration with complete admission checks and exact-child cancellation.
 * @module @deepseek-ai/dsh-tool-subagent-profiles/delegate
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { applyChildComposition, resolveChildDepth, SubagentError } from '@deepseek-ai/dsh-subagent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { discoverProfiles } from './profiles.ts'
import { resolveProfile } from './runtime.ts'
import { readProfileState } from './state.ts'
import type { DelegationEntry, DelegationRequest, ProfileToolSpec, ProfileRoute, SubagentProfileSnapshot } from './types.ts'

const entryFields = { agent: z.string().min(1), task: z.string().min(1), cwd: z.string().min(1).optional() }
const entrySchema = z.object(entryFields).strict().transform(({ cwd, ...entry }) => ({
  ...entry, ...cwd === undefined ? {} : { cwd },
}))
/** Model input validation; operator directories and project trust cannot be supplied here. */
export const delegationRequestSchema = z.union([
  z.object({ ...entryFields, resume: z.string().min(1).optional() }).strict().transform(({ cwd, resume, ...entry }) => ({
    ...entry, ...cwd === undefined ? {} : { cwd }, ...resume === undefined ? {} : { resume },
  })),
  z.object({ tasks: z.array(entrySchema).min(1) }).strict(),
  z.object({ chain: z.array(entrySchema).min(1) }).strict(),
])

interface PreparedEntry {
  readonly entry: DelegationEntry
  readonly profile: SubagentProfileSnapshot
  readonly cwd: string
}

type ChildReceipt = { agent: string; childId: SessionId }

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function resume(ctx: Context, parent: Agent, entry: DelegationEntry & { resume: string }, signal: AbortSignal): Promise<JsonValue> {
  if (entry.cwd !== undefined) throw new SubagentError('Resume preserves the recorded child directory; omit cwd', 'INVALID_PROFILE_REQUEST')
  if (/^(pi|paseo):/.test(entry.resume)) throw new SubagentError('Resume requires a native Harness child Session id', 'INVALID_PROFILE_REQUEST')
  const id = SessionId(entry.resume)
  using source = await ctx.sessionQuery.observeSession(id, { signal, projectionMode: 'none' })
  if (source.header.parentSession !== parent.id) throw new SubagentError('Only this exact parent can resume its direct child', 'UNAUTHORIZED')
  const recorded = Session.create(id, source.events, source.header, source.inheritedEventCount)
  const { snapshot } = readProfileState(ctx, recorded)
  if (snapshot === null || snapshot.name !== entry.agent) {
    throw new SubagentError('Resume agent must match the child\'s recorded Markdown profile', 'PROFILE_MISMATCH')
  }
  const messageId = await ctx.subagents.sendMessage(parent, id, [{ type: 'text', text: entry.task }], { signal })
  return { kind: 'continued', agent: entry.agent, childId: id, messageId }
}

async function prepare(ctx: Context, parent: Agent, spec: ProfileToolSpec, entries: readonly DelegationEntry[], signal: AbortSignal) {
  const catalog = await discoverProfiles({ ...spec,
    ...parent.session.header.cwd === undefined ? {} : { projectDirectory: parent.session.header.cwd },
  }, signal)
  const selected = entries.map((entry) => {
    const profile = catalog.profiles.get(entry.agent)
    if (profile === undefined) throw new SubagentError(`Unknown agent "${entry.agent}"; available agents: ${[...catalog.profiles.keys()].join(', ') || '(none)'}`, 'PROFILE_NOT_FOUND')
    return { entry, profile }
  })
  const maxDepth = ctx.subagents.resolveMaxDepth(spec.maxDepth)
  resolveChildDepth(parent, maxDepth)
  const probeKey = {}
  bindScopeParent(probeKey, parent)
  const probe = createScope(ctx, probeKey)
  try {
    await applyChildComposition(probe.ctx, parent, { agentPreset: spec.agentPreset })
    const base = await ctx.workingDirectory.ensure(parent, signal)
    const prepared: PreparedEntry[] = []
    for (const { entry, profile } of selected) {
      signal.throwIfAborted()
      const resolved = await resolveProfile(profile, parent, signal)
      if (resolved.tools !== undefined) {
        const lift = probe.ctx.tools.restrict({ allow: resolved.tools }, { includeScoped: true })
        lift()
      }
      const directory = await ctx.fs.resolve(entry.cwd ?? base, { cwd: base, signal })
      if ((await ctx.fs.stat(directory, signal))?.type !== 'directory') {
        throw new SubagentError(`Child directory does not exist: ${entry.cwd ?? base}`, 'INVALID_PROFILE_REQUEST')
      }
      prepared.push({ entry, profile: resolved, cwd: ctx.fs.processPath(directory) })
    }
    signal.throwIfAborted()
    return { prepared, maxDepth, diagnostics: catalog.diagnostics }
  } finally {
    await probe.dispose()
  }
}

async function chainResult(activation: SubagentActivation, signal: AbortSignal) {
  let cleanup: Promise<void> | undefined
  const cancel = (): void => {
    cleanup ??= activation.dispose()
    // Observed again in finally, including teardown failures.
    void cleanup.catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) cancel()
    const result = await activation.result
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', cancel)
    await cleanup
  }
}

/**
 * Execute one validated mode through the existing native activation manager.
 * @param ctx - Host services owning composition, discovery and execution-world paths.
 * @param spec - explicitly resolved deployment settings.
 * @param request - exactly one validated model-facing delegation mode.
 * @param exec - exact live caller and tool execution identity.
 * @param signal - fused caller and plugin cancellation.
 * @returns durable child acknowledgements, per-entry startup errors, or the final chain result.
 */
export async function executeDelegation(
  ctx: Context, spec: ProfileToolSpec, request: DelegationRequest, exec: ToolExecution, signal: AbortSignal,
): Promise<JsonValue> {
  const parent = exec.agent
  if (parent === undefined || ctx.agents.get(parent.id) !== parent) {
    throw new SubagentError('Profile delegation requires an exact live parent Agent', 'UNAUTHORIZED')
  }
  signal.throwIfAborted()
  if ('agent' in request && request.resume !== undefined) return resume(ctx, parent, { ...request, resume: request.resume }, signal)
  const entries = 'tasks' in request ? request.tasks : 'chain' in request ? request.chain : [request]
  const { prepared, maxDepth, diagnostics } = await prepare(ctx, parent, spec, entries, signal)
  const start = (item: PreparedEntry, task: string, delivery: 'parent' | 'caller') => ctx.subagents.startActivation({
    provider: spec.provider, label: item.profile.description, signal, delivery,
    request: { parent, cwd: item.cwd, prompt: [{ type: 'text', text: task }], agentOptions: item.profile.routes[0] as ProfileRoute,
      ...spec.agentPreset === undefined ? {} : { agentPreset: spec.agentPreset },
      ...maxDepth === undefined ? {} : { maxDepth },
    },
    childSetup: { key: 'markdown-profile', data: item.profile },
  })
  if ('chain' in request) {
    const children: ChildReceipt[] = []
    let output = ''
    for (const item of prepared) {
      signal.throwIfAborted()
      try {
        const activation = await start(item, item.entry.task.replaceAll('{previous}', output), 'caller')
        children.push({ agent: item.entry.agent, childId: activation.childId })
        const result = await chainResult(activation, signal)
        const text = result.output.filter(block => block.type === 'text').map(block => block.text).join('')
        if (result.stopReason !== 'completed' || text.length === 0) {
          return { kind: 'chain', status: 'failed', children, output: text, stopReason: result.stopReason,
            error: result.diagnostic ?? 'Child did not produce a trusted completed final text', diagnostics }
        }
        output = text
      } catch (error: unknown) {
        signal.throwIfAborted()
        return { kind: 'chain', status: 'failed', children, output, error: failureText(error), diagnostics }
      }
    }
    return { kind: 'chain', status: 'completed', children, output, diagnostics }
  }
  const starts = await Promise.allSettled(prepared.map(item => start(item, item.entry.task, 'parent')))
  const children = starts.map((result, index) => result.status === 'fulfilled'
    ? { agent: (prepared[index] as PreparedEntry).entry.agent, childId: result.value.childId }
    : { agent: (prepared[index] as PreparedEntry).entry.agent, error: failureText(result.reason) })
  return { kind: 'activations', children, diagnostics }
}
