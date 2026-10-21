/** Profile composition is committed before any child request and restored from its log. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { resolveProfile } from '../src/runtime.ts'
import { parseProfile } from '../src/profiles.ts'
import { setup, settled, snapshot, PolicyAdapter, mountRuntime } from './harness.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

describe('profile runtime', () => {
  it('applies literal persona and complete tool restrictions before first request', async () => {
    const { ctx, parent } = await setup()
    const adapter = new PolicyAdapter([textResponse('reviewed'), textResponse('reviewed again')])
    ctx.llm.registerAdapter(['a'], adapter)
    ctx.tools.register({ name: 'hidden', description: 'Hidden', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: () => Promise.resolve('should not run'),
    })
    await mountRuntime(ctx)
    const profile = { ...snapshot(), tools: [] }
    const activation = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'review', delivery: 'parent', signal: new AbortController().signal,
      request: { parent, prompt: [{ type: 'text', text: 'review' }], agentOptions: profile.routes[0]! },
      childSetup: { key: 'markdown-profile', data: profile },
    })
    const stored = await settled(ctx, activation.childId)
    expect(adapter.requests[0]?.tools ?? []).toEqual([])
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Review {{literal}}.')
    expect(ctx.tools.schemas(parent).map(tool => tool.name)).toContain('hidden')
    expect(stored.events.filter(event => event.type === 'subagent/profile')).toHaveLength(1)
    await ctx.subagents.sendMessage(parent, activation.childId, [{ type: 'text', text: 'again' }], { signal: new AbortController().signal })
    await settled(ctx, activation.childId)
    // Restoration reaches the persisted profile, not a file path or new definition.
    expect(adapter.requests[1]?.tools ?? []).toEqual([])
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Review {{literal}}.')
  })

  it('resolves omitted models from the parent and preflights suffix compatibility', async () => {
    const { ctx, parent } = await setup()
    const parsed = parseProfile('---\nname: scout\ndescription: Read\n---\nScout', 'scout.md', 'user')
    expect((await resolveProfile(parsed, parent, new AbortController().signal)).routes)
      .toEqual([{ provider: 'parent', model: 'parent-model' }])
    ctx.llm.registerAdapter(['a'], new PolicyAdapter([], undefined, {
      efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
    }))
    const unsupported = parseProfile('---\nname: scout\ndescription: Read\nmodel: a/model:high\n---\nScout', 'scout.md', 'user')
    await expect(resolveProfile(unsupported, parent, new AbortController().signal)).rejects.toThrow(/reasoning|effort/i)
    const missing = { ...parsed, routes: [{ provider: 'missing', model: 'model' }] }
    await expect(resolveProfile(missing, parent, new AbortController().signal)).rejects.toThrow()
  })

  it('refuses a restored route with newly unsupported effort before publishing the child', async () => {
    const { ctx, parent } = await setup()
    const old = new PolicyAdapter([textResponse('first')], undefined, { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] })
    const unregister = ctx.llm.registerAdapter(['a'], old)
    await mountRuntime(ctx)
    const profile = snapshot([{ provider: 'a', model: 'one', reasoningEffort: ReasoningEffortId('high') }])
    const started = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'review', delivery: 'parent', signal: new AbortController().signal,
      request: { parent, prompt: [{ type: 'text', text: 'work' }], agentOptions: profile.routes[0]! },
      childSetup: { key: 'markdown-profile', data: profile },
    })
    await settled(ctx, started.childId)
    unregister()
    const replacement = new PolicyAdapter([], undefined, { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] })
    ctx.llm.registerAdapter(['a'], replacement)
    const created: string[] = []
    ctx.on('agent/created', ({ agent }) => { created.push(agent.id) })
    await expect(ctx.subagents.sendMessage(parent, started.childId, [{ type: 'text', text: 'continue' }], {
      signal: new AbortController().signal,
    })).rejects.toThrow()
    expect(created).toEqual([])
    expect(replacement.requests).toEqual([])
  })

  it('refuses cold restoration when the required profile snapshot is absent', async () => {
    const { ctx, parent } = await setup()
    const adapter = new PolicyAdapter([])
    ctx.llm.registerAdapter(['a'], adapter)
    await mountRuntime(ctx)
    const incomplete = await ctx.agents.create({
      sessionId: SessionId('missing-profile'), parentAgent: parent,
      meta: { parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
      setup: (_childCtx, child) => {
        child.session.append('subagent/descriptor', { version: 4, childSetup: 'markdown-profile', mode: 'continuable',
          provider: 'spawn', label: 'incomplete', agentProvider: 'a', agentModel: 'one' })
      },
    })
    await incomplete.dispose()
    await expect(ctx.subagents.sendMessage(parent, incomplete.agent.id, [{ type: 'text', text: 'continue' }], {
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
    expect(ctx.agents.get(incomplete.agent.id)).toBeUndefined()
    expect(adapter.requests).toEqual([])
  })

  it('fails on unknown tools rather than granting an unrestricted child', async () => {
    const { ctx, parent } = await setup()
    ctx.llm.registerAdapter(['a'], new PolicyAdapter([]))
    await mountRuntime(ctx)
    await expect(ctx.subagents.startActivation({
      provider: 'spawn', label: 'review', delivery: 'parent', signal: new AbortController().signal,
      request: { parent, prompt: [{ type: 'text', text: 'review' }], agentOptions: { provider: 'a', model: 'one' } },
      childSetup: { key: 'markdown-profile', data: { ...snapshot(), tools: ['not-installed'] } },
    })).rejects.toThrow(/unknown.*not-installed/)
    expect(ctx.agents.list()).toEqual([parent])
  })
})
