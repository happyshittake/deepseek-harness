/** Registered child setup runs before publication and survives cold continuation. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Subagents, { foldSubagentDescriptor, snapshotSubagentDescriptor } from '../src/index.ts'
import type { SubagentActivationSpec, SubagentChildSetupHandler } from '../src/index.ts'
import { mountLocalActivations } from './local-activation.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession } from './persistence-helpers.ts'

async function setup() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  const adapter = new MockAdapter(Array.from({ length: 8 }, () => textResponse('done')))
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent: parent } = await ctx.agents.create({
    sessionId: SessionId('parent'), agentOptions: { provider: 'mock', model: 'mock' },
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent ? { kind: 'reject' } : next())
  return { ctx, parent, adapter }
}

function spec(parent: Agent, overrides: Partial<SubagentActivationSpec> = {}): SubagentActivationSpec {
  return {
    provider: 'spawn', label: 'setup child', delivery: 'parent',
    request: { parent, prompt: [{ type: 'text', text: 'work' }] },
    signal: new AbortController().signal,
    childSetup: { key: 'test-profile', data: { marker: 'first' } },
    ...overrides,
  }
}

async function settled(ctx: Context, childId: SessionId) {
  await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() })
  return loadStoredSession(ctx.sessionPersistence, childId)
}

describe('registered child setup', () => {
  it('isolates concurrent startup JSON and initializes before publication', async () => {
    const { ctx, parent } = await setup()
    const initialized = new Map<SessionId, unknown>()
    ctx.subagents.registerChildSetup('test-profile', (_childCtx, child, input) => {
      expect(ctx.agents.get(child.id)).toBeUndefined()
      initialized.set(child.id, input)
    })
    const published: SessionId[] = []
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) {
        expect(initialized.has(agent.id)).toBe(true)
        published.push(agent.id)
      }
    })
    const data = { marker: 'first' }
    const first = ctx.subagents.startActivation(spec(parent, { childSetup: { key: 'test-profile', data } }))
    data.marker = 'mutated after admission'
    const second = ctx.subagents.startActivation(spec(parent, { childSetup: { key: 'test-profile', data: 'second' } }))
    const [a, b] = await Promise.all([first, second])
    expect(initialized.get(a.childId)).toEqual({ kind: 'startup', data: { marker: 'first' } })
    expect(initialized.get(b.childId)).toEqual({ kind: 'startup', data: 'second' })
    expect(published).toHaveLength(2)
    const stored = await settled(ctx, a.childId)
    expect(foldSubagentDescriptor(stored.events)).toMatchObject({ version: 4, childSetup: 'test-profile' })
    expect(JSON.stringify(stored.events.find(event => event.type === 'subagent/descriptor')?.data)).not.toContain('marker')
    await settled(ctx, b.childId)
  })

  it('reuses the registered handler on cold resume without startup data', async () => {
    const { ctx, parent, adapter } = await setup()
    const inputs: unknown[] = []
    ctx.subagents.registerChildSetup('test-profile', (_childCtx, _child, input) => { inputs.push(input) })
    const started = await ctx.subagents.startActivation(spec(parent))
    await settled(ctx, started.childId)
    await ctx.subagents.sendMessage(parent, started.childId, [{ type: 'text', text: 'continue' }], {
      signal: new AbortController().signal,
    })
    const stored = await settled(ctx, started.childId)
    expect(inputs).toEqual([{ kind: 'startup', data: { marker: 'first' } }, { kind: 'resume' }])
    expect(stored.events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(2)
  })

  it('refuses a missing handler before creation and after cold storage', async () => {
    const { ctx, parent, adapter } = await setup()
    await expect(ctx.subagents.startActivation(spec(parent))).rejects.toMatchObject({ code: 'CHILD_SETUP_UNAVAILABLE' })
    const dispose = ctx.subagents.registerChildSetup('test-profile', () => {})
    const started = await ctx.subagents.startActivation(spec(parent))
    await settled(ctx, started.childId)
    dispose()
    await expect(ctx.subagents.sendMessage(parent, started.childId, [{ type: 'text', text: 'continue' }], {
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'CHILD_SETUP_UNAVAILABLE' })
    expect(ctx.agents.list()).toEqual([parent])
    expect(adapter.requests).toHaveLength(1)
  })

  it('rolls back failed setup without publishing or leaking admission', async () => {
    const { ctx, parent, adapter } = await setup()
    const count = ctx.sessions.list().length
    const created: SessionId[] = []
    ctx.on('agent/created', ({ agent }) => { created.push(agent.id) })
    const dispose = ctx.subagents.registerChildSetup('test-profile', () => { throw new Error('broken setup') })
    await expect(ctx.subagents.startActivation(spec(parent))).rejects.toThrow('broken setup')
    expect(created).toEqual([])
    expect(ctx.sessions.list()).toHaveLength(count)
    expect(adapter.requests).toHaveLength(0)
    dispose()
    ctx.subagents.registerChildSetup('test-profile', () => {})
    const started = await ctx.subagents.startActivation(spec(parent))
    await settled(ctx, started.childId)
    expect(adapter.requests).toHaveLength(1)
  })

  it('rejects duplicate setup keys and allows replacement after effect disposal', async () => {
    const { ctx } = await setup()
    const handler: SubagentChildSetupHandler = () => {}
    const fiber = await ctx.plugin(Object.assign((pluginCtx: Context) => {
      pluginCtx.subagents.registerChildSetup('test-profile', handler)
    }, { inject: ['subagents'] }))
    expect(() => ctx.subagents.registerChildSetup('test-profile', handler)).toThrow(/already registered/)
    await fiber.dispose()
    expect(() => ctx.subagents.registerChildSetup('test-profile', handler)).not.toThrow()
  })

  it('rejects setup for an external backend before dispatch', async () => {
    const { ctx, parent } = await setup()
    const start = vi.fn()
    ctx.subagents.registerProvider({
      name: 'external', inheritsParentContext: false,
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: true }, start,
    })
    await expect(ctx.subagents.startActivation(spec(parent, { provider: 'external' })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    expect(start).not.toHaveBeenCalled()
  })

  it('forwards initialization cancellation into an asynchronous setup handler', async () => {
    const { ctx, parent, adapter } = await setup()
    const controller = new AbortController()
    const ready = Promise.withResolvers<AbortSignal | undefined>()
    ctx.subagents.registerChildSetup('test-profile', async (_ctx, _child, _input, signal) => {
      ready.resolve(signal)
      if (signal !== undefined) await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('cancel initialization')) }, { once: true })
      })
    })
    const starting = ctx.subagents.startActivation(spec(parent, { signal: controller.signal }))
    const signal = await ready.promise
    controller.abort(new Error('cancel initialization'))
    await expect(starting).rejects.toThrow('cancel initialization')
    expect(signal?.aborted).toBe(true)
    expect(ctx.agents.list()).toEqual([parent])
    expect(adapter.requests).toEqual([])
  })

  it('refuses an initializer replaced during asynchronous provider preparation', async () => {
    const { ctx, parent, adapter } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.subagents.registerProvider({ name: 'gated', inheritsParentContext: false,
      capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
      prepareContinuable: async () => { entered.resolve(undefined); await release.promise; return {} },
    })
    const remove = ctx.subagents.registerChildSetup('test-profile', () => {})
    const starting = ctx.subagents.startActivation(spec(parent, { provider: 'gated' }))
    await entered.promise
    remove()
    ctx.subagents.registerChildSetup('test-profile', () => { throw new Error('replacement must not run') })
    release.resolve(undefined)
    await expect(starting).rejects.toMatchObject({ code: 'CHILD_SETUP_UNAVAILABLE' })
    expect(ctx.agents.list()).toEqual([parent])
    expect(adapter.requests).toEqual([])
  })

  it('refuses publication when its initializer unloads during asynchronous setup', async () => {
    const { ctx, parent, adapter } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const remove = ctx.subagents.registerChildSetup('test-profile', async () => {
      entered.resolve(undefined)
      await release.promise
    })
    const starting = ctx.subagents.startActivation(spec(parent))
    await entered.promise
    remove()
    release.resolve(undefined)
    await expect(starting).rejects.toMatchObject({ code: 'CHILD_SETUP_UNAVAILABLE' })
    expect(ctx.agents.list()).toEqual([parent])
    expect(adapter.requests).toEqual([])
  })

  it('keeps unextended descriptors at version 3', () => {
    expect(snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'ordinary' }))
      .toEqual({ version: 3, mode: 'continuable', provider: 'spawn', label: 'ordinary' })
  })
})
