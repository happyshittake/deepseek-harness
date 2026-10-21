/** Provider-owned retries advance physical routes without replaying completed tools. */
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { setup, settled, snapshot, PolicyAdapter, mountRuntime, startProfile, failure } from './harness.ts'

const routes = [{ provider: 'a', model: 'one' }, { provider: 'b', model: 'two' }]

describe('profile fallback', () => {
  it.each([false, true])('retains one side effect and cold-resumes the selected route (retry reload: %s)', async (reload) => {
    const { ctx, parent, retry } = await setup()
    let writes = 0
    ctx.tools.register({
      name: 'save', description: 'Save once', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: () => { writes += 1; return Promise.resolve('saved once') },
    })
    const a = new PolicyAdapter([toolCallResponse('save-1', 'save', {}), failure()])
    const b = new PolicyAdapter([textResponse('recovered'), textResponse('continued')])
    ctx.llm.registerAdapter(['a'], a)
    ctx.llm.registerAdapter(['b'], b)
    await mountRuntime(ctx)
    if (reload) { await retry.dispose(); await ctx.plugin(Retry) }
    const activation = await startProfile(ctx, parent, snapshot(routes))
    expect(await activation.result).toMatchObject({ stopReason: 'completed', output: [{ type: 'text', text: 'recovered' }] })
    const stored = await settled(ctx, activation.childId)
    expect(writes).toBe(1)
    expect(a.requests).toHaveLength(2)
    expect(b.requests).toHaveLength(1)
    expect(JSON.stringify(b.requests[0]?.messages)).toContain('saved once')
    expect(stored.events.filter(event => event.type === 'subagent/profile-route').map(event => event.data)).toEqual([{ index: 1 }])
    expect(stored.events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(stored.events.filter(event => event.type === 'request/header').map(event => event.data.header.config.provider)).toEqual(['a', 'b'])
    await ctx.subagents.sendMessage(parent, activation.childId, [{ type: 'text', text: 'continue' }], { signal: new AbortController().signal })
    await settled(ctx, activation.childId)
    expect(a.requests).toHaveLength(2)
    expect(b.requests).toHaveLength(2)
    expect(writes).toBe(1)
  })

  it('clears old effort on the next route and preserves unrelated request controls', async () => {
    const { ctx, parent } = await setup()
    const a = new PolicyAdapter([failure()], undefined, { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] })
    const b = new PolicyAdapter([textResponse('done')])
    ctx.llm.registerAdapter(['a'], a)
    ctx.llm.registerAdapter(['b'], b)
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), temperature: 0.7 }))
    await mountRuntime(ctx)
    const activation = await startProfile(ctx, parent, snapshot([{ ...routes[0]!, reasoningEffort: ReasoningEffortId('high') }, routes[1]!]))
    expect((await activation.result).stopReason).toBe('completed')
    expect(a.requests[0]?.reasoningEffort).toBe('high')
    expect(b.requests[0]?.reasoningEffort).toBeUndefined()
    expect(b.requests[0]?.temperature).toBe(0.7)
  })

  it('keeps ordinary retries for a single route', async () => {
    const { ctx, parent } = await setup()
    const a = new PolicyAdapter([failure(), textResponse('retried')])
    ctx.llm.registerAdapter(['a'], a)
    await mountRuntime(ctx)
    const activation = await startProfile(ctx, parent)
    expect((await activation.result).stopReason).toBe('completed')
    expect(a.requests).toHaveLength(2)
    const stored = await settled(ctx, activation.childId)
    expect(stored.events.filter(event => event.type === 'subagent/profile-route')).toEqual([])
  })

  it('stops at the end of an explicit chain even under always retry', async () => {
    const { ctx, parent } = await setup()
    const always = { mode: 'always' as const, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }
    const a = new PolicyAdapter([failure()], always)
    const b = new PolicyAdapter([failure(), textResponse('must not retry')], always)
    ctx.llm.registerAdapter(['a'], a)
    ctx.llm.registerAdapter(['b'], b)
    await mountRuntime(ctx)
    const activation = await startProfile(ctx, parent, snapshot(routes))
    expect((await activation.result).stopReason).not.toBe('completed')
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(1)
  })

  it.each(['denied', 'exhausted', 'missing-credentials', 'invalid-credentials', 'auth', 'success-text'] as const)('does not fall back for %s', async (kind) => {
    const { ctx, parent } = await setup()
    const code = kind === 'missing-credentials' ? 'MISSING_CREDENTIAL' : kind === 'invalid-credentials' ? 'INVALID_CREDENTIAL' : kind === 'auth' ? 'AUTH' : kind === 'denied' ? 'BAD_REQUEST' : 'SERVER'
    const a = new PolicyAdapter([kind === 'success-text' ? textResponse('error: SERVER') : failure(code)], {
      mode: kind.includes('credentials') || kind === 'auth' ? 'always' : 'normal',
      maxRetries: kind === 'exhausted' ? 0 : 1,
      retryableCodes: ['SERVER'], backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    })
    const b = new PolicyAdapter([textResponse('must not run')])
    ctx.llm.registerAdapter(['a'], a)
    ctx.llm.registerAdapter(['b'], b)
    await mountRuntime(ctx)
    const activation = await startProfile(ctx, parent, snapshot(routes))
    await activation.result
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toEqual([])
  })

  it('cancels a provider-owned delay without selecting or starting another route', async () => {
    const { ctx, parent } = await setup()
    const a = new PolicyAdapter([failure()], { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 } })
    const b = new PolicyAdapter([textResponse('must not run')])
    ctx.llm.registerAdapter(['a'], a)
    ctx.llm.registerAdapter(['b'], b)
    await mountRuntime(ctx)
    const waiting = Promise.withResolvers<undefined>()
    ctx.on('session/event', (_session, event) => { if (event.type === 'llm/retry') waiting.resolve(undefined) })
    const activation = await startProfile(ctx, parent, snapshot(routes))
    await waiting.promise
    await activation.dispose()
    const stored = await settled(ctx, activation.childId)
    expect(b.requests).toEqual([])
    expect(stored.events.filter(event => event.type === 'subagent/profile-route')).toEqual([])
  })

  it('drains only owned profile children on plugin unload', async () => {
    const { ctx, parent } = await setup()
    const a = new PolicyAdapter(['hang', 'hang'])
    ctx.llm.registerAdapter(['a'], a)
    const runtime = await mountRuntime(ctx)
    const ordinary = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'ordinary sibling', delivery: 'caller', signal: new AbortController().signal,
      request: { parent, prompt: [{ type: 'text', text: 'ordinary work' }], agentOptions: { provider: 'a', model: 'one' } },
    })
    const activation = await startProfile(ctx, parent)
    await vi.waitFor(() => { expect(a.requests).toHaveLength(2) })
    await runtime.dispose()
    expect(ctx.agents.get(activation.childId)).toBeUndefined()
    expect(ctx.agents.get(parent.id)).toBe(parent)
    expect(ctx.agents.get(ordinary.childId)).toBeDefined()
    await ordinary.dispose()
    await expect(ctx.subagents.sendMessage(parent, activation.childId, [{ type: 'text', text: 'continue' }], { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'CHILD_SETUP_UNAVAILABLE' })
  })
})
