/** Profile-owned child composition and provider-admitted, same-Session routing.
 * @module @deepseek-ai/dsh-tool-subagent-profiles/runtime
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { INVALID_CREDENTIAL_CODE } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import { profileProjection, profileSnapshotSchema, readProfileState } from './state.ts'
import type { ParsedProfile, ProfileRoute, SubagentProfileSnapshot } from './types.ts'

/**
 * Freeze instructions and validate every route through its live adapter.
 * @param profile - parsed operator-approved Markdown definition.
 * @param parent - exact live parent supplying an omitted route.
 * @param signal - cancellation before dispatch.
 * @returns child-owned instructions and validated physical routes, without credentials.
 */
export async function resolveProfile(profile: ParsedProfile, parent: Agent, signal: AbortSignal): Promise<SubagentProfileSnapshot> {
  const inherited = parentAgentOptionsForDelegation(parent)
  const routes: ProfileRoute[] = profile.routes === undefined ? (() => {
    if (inherited.provider === undefined || inherited.model === undefined) {
      throw new Error('profile has no model and parent has no effective provider/model route')
    }
    return [{ provider: inherited.provider, model: inherited.model,
      ...inherited.reasoningEffort === undefined ? {} : { reasoningEffort: inherited.reasoningEffort } }]
  })() : profile.routes.map(route => ({ ...route }))
  for (const route of routes) {
    signal.throwIfAborted()
    await parent.ctx.llm.resolveCallConfig(route, signal)
  }
  signal.throwIfAborted()
  return { name: profile.name, description: profile.description, source: profile.source, persona: profile.persona,
    ...profile.tools === undefined ? {} : { tools: [...profile.tools] }, routes }
}

/**
 * Apply a logged profile before publication, preserving unrelated request controls.
 * @param childCtx - unpublished child's scoped registration context.
 * @param child - exact child whose projection owns routing.
 * @param snapshot - validated, already-persisted instructions and routes.
 * @param lifetime - owning plugin cancellation, retained through child teardown.
 */
export function installProfileRuntime(childCtx: Context, child: Agent, snapshot: SubagentProfileSnapshot, lifetime: AbortSignal): void {
  childCtx.systemPrompt.section({
    name: 'deployment:persona-prefix', order: childCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: snapshot.persona, interpolate: false,
  })
  if (snapshot.tools !== undefined) childCtx.tools.restrict({ allow: snapshot.tools }, { includeScoped: true })
  childCtx.on('agent/request', async (_payload, next) => {
    lifetime.throwIfAborted()
    const normal = await next()
    lifetime.throwIfAborted()
    const state = readProfileState(childCtx, child.session)
    const route = snapshot.routes[state.index] as ProfileRoute
    const { reasoningEffort: _previousEffort, ...controls } = normal
    return { ...controls, ...route }
  }, { prepend: true })
  childCtx.on('agent/request-error', async ({ failure, retryPolicy, signal }, next) => {
    if (snapshot.routes.length === 1) return next()
    const state = readProfileState(childCtx, child.session)
    if (signal.aborted || lifetime.aborted || state.index === snapshot.routes.length - 1
      || failure.code === 'MISSING_CREDENTIAL' || failure.code === INVALID_CREDENTIAL_CODE || failure.code === 'AUTH') return
    const decision = await next()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- both flags can change during awaited provider backoff.
    if (signal.aborted || lifetime.aborted) return
    const after = readProfileState(childCtx, child.session)
    // Only the native provider-policy executor can supply durable admission evidence.
    if (retryPolicy === undefined || decision?.kind !== 'retry' || after.retryStarts === state.retryStarts) return
    child.session.append('subagent/profile-route', { index: state.index + 1 })
    return decision
  }, { prepend: true })
}

/**
 * Register restorable profile setup and drain only this plugin's children on unload.
 * @param ctx - Host plugin context owning setup, projection, and cleanup.
 * @returns its cancellation controller; the tool aborts it before draining active invocations.
 */
export function registerProfileRuntime(ctx: Context): AbortController {
  const lifetime = new AbortController()
  const children = new Map<Agent, Set<SessionId>>()
  ctx.sessionProjections.register(profileProjection)
  ctx.subagents.registerChildSetup('markdown-profile', async (childCtx, child, input, signal) => {
    lifetime.signal.throwIfAborted()
    if (input.kind === 'startup') child.session.append('subagent/profile', profileSnapshotSchema.parse(input.data))
    const state = readProfileState(childCtx, child.session)
    const { snapshot } = state
    if (snapshot === null) throw new Error('profile child has no persisted profile snapshot')
    if (input.kind === 'resume') {
      await childCtx.llm.resolveCallConfig(snapshot.routes[state.index] as ProfileRoute, AbortSignal.any([signal, lifetime.signal]))
      signal.throwIfAborted()
      lifetime.signal.throwIfAborted()
    }
    installProfileRuntime(childCtx, child, snapshot, lifetime.signal)
    const parentId = child.session.header.parentSession
    const parent = parentId === undefined ? undefined : ctx.agents.get(parentId)
    if (parent === undefined) throw new Error('profile child requires its exact live parent')
    let ids = children.get(parent)
    if (ids === undefined) { ids = new Set(); children.set(parent, ids) }
    const ownedIds = ids
    ownedIds.add(child.id)
    childCtx.effect(() => () => {
      ownedIds.delete(child.id)
      if (ownedIds.size === 0) children.delete(parent)
    }, 'profile child ownership')
  })
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Markdown profile plugin unloaded'))
    const results = await Promise.allSettled([...children].map(([parent, ids]) => ctx.subagents.drainChildren(parent, [...ids])))
    const failures: unknown[] = []
    for (const result of results) {
      if (result.status === 'rejected') {
        const reason: unknown = result.reason
        failures.push(reason)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Failed to drain Markdown profile children')
  }, 'profile runtime teardown')
  return lifetime
}
