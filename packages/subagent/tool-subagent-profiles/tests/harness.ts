/** Real agent/subagent lifecycle with scripted adapters and isolated persistence. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { registerProfileRuntime } from '../src/runtime.ts'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations } from '../../subagent/tests/local-activation.ts'
import { TestSessionQuery } from '../../subagent/tests/test-session-query.ts'
import { loadStoredSession } from '../../subagent/tests/persistence-helpers.ts'
import { expect, vi } from 'vitest'
import type { ProfileRoute, SubagentProfileSnapshot } from '../src/types.ts'

/** A physical model route whose retry policy remains adapter-owned. */
export class PolicyAdapter extends MockAdapter {
  private readonly policy: ResolvedRetryPolicy
  constructor(script: ConstructorParameters<typeof MockAdapter>[0], policy: RetryPolicyConfig = {
    mode: 'normal', maxRetries: 2, retryableCodes: ['SERVER'], backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, reasoning?: ConstructorParameters<typeof MockAdapter>[1]) {
    super(script, reasoning)
    this.policy = resolveRetryPolicy(policy, 'profile test retryPolicy')
  }
  override providerRetryPolicy(): ResolvedRetryPolicy { return this.policy }
}

/** Script a normalized transport failure rather than a successful error-like answer. */
export function failure(code = 'SERVER'): () => never {
  return () => { throw new LlmError('test provider failure', code) }
}

/** Native fixture, keeping retry, persistence, prompt assembly and dispatch real. */
export async function setup() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(Subagents)
  const spawn = await ctx.plugin(Spawn, { providerName: 'spawn' })
  const retry = await ctx.plugin(Retry)
  const parentAdapter = new MockAdapter([textResponse('parent')])
  ctx.llm.registerAdapter(['parent'], parentAdapter)
  const { agent: parent } = await ctx.agents.create({
    sessionId: SessionId('parent'), agentOptions: { provider: 'parent', model: 'parent-model' },
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent ? { kind: 'reject' } : next())
  return { ctx, parent, retry, parentAdapter, spawn }
}

/** Resolved child profile payload with no optional capability grants. */
export function snapshot(routes: ProfileRoute[] = [{ provider: 'a', model: 'one' }]): SubagentProfileSnapshot {
  return { name: 'reviewer', description: 'Review changes', source: 'user', persona: 'Review {{literal}}.', routes }
}

/** Mount profile ownership and its native setup registration under an unloadable fiber. */
export function mountRuntime(ctx: Context) {
  return ctx.plugin(Object.assign((owned: Context) => { registerProfileRuntime(owned) }, {
    inject: ['agents', 'subagents', 'sessionProjections', 'systemPrompt', 'tools'],
  }))
}

/** Start the production managed activation with a previously resolved snapshot. */
export function startProfile(ctx: Context, parent: Agent, profile = snapshot()) {
  return ctx.subagents.startActivation({
    provider: 'spawn', label: profile.description, delivery: 'parent', signal: new AbortController().signal,
    request: { parent, prompt: [{ type: 'text', text: 'work' }], agentOptions: profile.routes[0]! },
    childSetup: { key: 'markdown-profile', data: profile },
  })
}

/** Wait on native settlement then open the persisted child for assertions. */
export async function settled(ctx: Context, childId: SessionId) {
  await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() })
  return loadStoredSession(ctx.sessionPersistence, childId)
}
