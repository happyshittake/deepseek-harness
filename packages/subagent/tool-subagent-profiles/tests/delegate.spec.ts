/** The registered model-facing tool delegates through native activations. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { PolicyAdapter, failure } from './harness.ts'

import { fixture, call, childIds } from './tool-harness.ts'

describe('profile delegation tool', () => {
  it('starts a child and returns its native id without awaiting the model', async () => {
    const env = await fixture()
    const result = await call(env, { agent: 'reviewer', task: 'Review this change' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ kind: 'activations', children: [{ agent: 'reviewer' }] })
    const [id] = childIds(result)
    await vi.waitFor(() =>{  expect(env.a.requests).toHaveLength(1) })
    expect(env.ctx.agents.get(id!)?.session.header.parentSession).toBe(env.parent.id)
    expect(JSON.stringify(env.a.requests[0]?.messages)).toContain('Reviewer persona.')
  })

  it('preflights every parallel entry before accepting any work', async () => {
    const env = await fixture()
    const result = await call(env, { tasks: [{ agent: 'reviewer', task: 'work' }, { agent: 'missing', task: 'work' }] })
    expect(result.isError).toBe(true)
    expect(env.ctx.agents.list()).toEqual([env.parent])
    expect(env.a.requests).toEqual([])
    expect(env.b.requests).toEqual([])
  })

  it('rejects unknown tool restrictions across the entire parallel request before start', async () => {
    const env = await fixture()
    await writeFile(join(env.directory, 'scout.md'), '---\nname: scout\ndescription: Scout files\nmodel: b/two\ntools: [not-installed]\n---\nScout.')
    const result = await call(env, { tasks: [{ agent: 'reviewer', task: 'work' }, { agent: 'scout', task: 'work' }] })
    expect(result.isError).toBe(true)
    expect(env.ctx.agents.list()).toEqual([env.parent])
    expect(env.a.requests).toEqual([])
  })

  it('starts parallel profiles without mixing personas or routes', async () => {
    const env = await fixture()
    const result = await call(env, { tasks: [{ agent: 'reviewer', task: 'review' }, { agent: 'scout', task: 'scout' }] })
    expect(result.isError).toBe(false)
    expect(childIds(result)).toHaveLength(2)
    await vi.waitFor(() => { expect(env.a.requests).toHaveLength(1); expect(env.b.requests).toHaveLength(1) })
    expect(JSON.stringify(env.a.requests[0]?.messages)).toContain('Reviewer persona.')
    expect(JSON.stringify(env.a.requests[0]?.messages)).not.toContain('Scout persona.')
    expect(JSON.stringify(env.b.requests[0]?.messages)).toContain('Scout persona.')
  })

  it('keeps overlapping callers bound to their own exact parents', async () => {
    const env = await fixture()
    const { agent: other } = await env.ctx.agents.create({ sessionId: SessionId('other-parent'), agentOptions: { provider: 'parent', model: 'parent-model' } })
    const [first, second] = await Promise.all([
      call(env, { agent: 'reviewer', task: 'review' }),
      call(env, { agent: 'scout', task: 'scout' }, other),
    ])
    const [review] = childIds(first)
    const [scout] = childIds(second)
    expect(env.ctx.agents.get(review!)?.session.header.parentSession).toBe(env.parent.id)
    expect(env.ctx.agents.get(scout!)?.session.header.parentSession).toBe(other.id)
    expect(review).not.toBe(scout)
  })

  it.each([
    {}, { tasks: [] }, { chain: [] }, { agent: 'reviewer', task: 'work', tasks: [{ agent: 'scout', task: 'work' }] },
    { tasks: [{ agent: 'scout', task: 'work' }], resume: 'child' }, { agent: 'reviewer', task: '' },
    { agent: 'reviewer', task: 'work', agentScope: 'project' },
  ])('rejects ambiguous, empty, or model-selected scope inputs: %j', async (args) => {
    const env = await fixture()
    expect((await call(env, args)).isError).toBe(true)
    expect(env.ctx.agents.list()).toEqual([env.parent])
  })

  it('passes successful final text to the next chain child with caller-owned delivery', async () => {
    const env = await fixture()
    env.replaceAdapter('a', new PolicyAdapter([(options) => {
      expect(JSON.stringify(options.messages)).toContain('Start: ')
      return textResponse('first result')
    }]))
    env.replaceAdapter('b', new PolicyAdapter([(options) => {
      expect(JSON.stringify(options.messages)).toContain('Then first result + first result')
      return textResponse('final result')
    }]))
    const result = await call(env, { chain: [{ agent: 'reviewer', task: 'Start: {previous}' }, { agent: 'scout', task: 'Then {previous} + {previous}' }] })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ kind: 'chain', status: 'completed', output: 'final result' })
    expect(childIds(result)).toHaveLength(2)
    expect(env.ctx.agents.list()).toEqual([env.parent])
    expect(env.parent.session.snapshotEvents().filter(event => event.type === 'user/message')).toEqual([])
  })

  it('stops a failed chain and retains its started child id', async () => {
    const env = await fixture()
    env.replaceAdapter('a', new PolicyAdapter([failure('AUTH')]))
    const result = await call(env, { chain: [{ agent: 'reviewer', task: 'fail' }, { agent: 'scout', task: 'must not start' }] })
    expect(result.value).toMatchObject({ kind: 'chain', status: 'failed' })
    expect(childIds(result)).toHaveLength(1)
    expect(env.b.requests).toEqual([])
  })

  it('cancels an active chain, awaits teardown, and never starts the next entry', async () => {
    const env = await fixture()
    const controller = new AbortController()
    const running = call(env, { chain: [{ agent: 'reviewer', task: 'wait' }, { agent: 'scout', task: 'must not start' }] }, env.parent, controller.signal)
    await vi.waitFor(() =>{  expect(env.a.requests).toHaveLength(1) })
    controller.abort(new Error('stop chain'))
    await running
    expect(env.ctx.agents.list()).toEqual([env.parent])
    expect(env.b.requests).toEqual([])
  })

  it('discovers additions on assembly but does not expose project paths without opt-in', async () => {
    const env = await fixture()
    await writeFile(join(env.directory, 'new.md'), '---\nname: extra\ndescription: Newly added\n---\nExtra.')
    const assembly = await env.ctx.systemPrompt.assemble()
    expect(assembly.sections.map(section => section.text).join('\n')).toContain('extra: Newly added')
    await mkdir(join(env.directory, '.dsh/agents'), { recursive: true })
    await writeFile(join(env.directory, '.dsh/agents/project.md'), '---\nname: project-only\ndescription: Project instructions\n---\nProject.')
    expect((await call(env, { agent: 'project-only', task: 'work' })).isError).toBe(true)
  })
})
