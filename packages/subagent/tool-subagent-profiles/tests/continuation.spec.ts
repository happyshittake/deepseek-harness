/** Resume honors durable profile identity and the exact live parent, not changed files. */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { PolicyAdapter, settled } from './harness.ts'
import { fixture, call, childIds } from './tool-harness.ts'

describe('profile continuation', () => {
  it('continues the same native child after its definition is deleted', async () => {
    const env = await fixture()
    const adapter = new PolicyAdapter([textResponse('first'), textResponse('second')])
    env.replaceAdapter('a', adapter)
    const [id] = childIds(await call(env, { agent: 'reviewer', task: 'work' }))
    await settled(env.ctx, id!)
    await rm(join(env.directory, 'reviewer.md'))
    const result = await call(env, { agent: 'reviewer', task: 'continue', resume: id })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ kind: 'continued', childId: id })
    const stored = await settled(env.ctx, id!)
    expect(adapter.requests).toHaveLength(2)
    expect(stored.events.filter(event => event.type === 'subagent/profile')).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Reviewer persona.')
  })

  it('rejects mismatched profile, foreign handles, and new cwd on resume', async () => {
    const env = await fixture()
    env.replaceAdapter('a', new PolicyAdapter([textResponse('first')]))
    const [id] = childIds(await call(env, { agent: 'reviewer', task: 'work' }))
    await settled(env.ctx, id!)
    for (const args of [
      { agent: 'scout', task: 'continue', resume: id },
      { agent: 'reviewer', task: 'continue', resume: 'pi:session' },
      { agent: 'reviewer', task: 'continue', resume: 'paseo:session' },
      { agent: 'reviewer', task: 'continue', resume: id, cwd: '/elsewhere' },
    ]) expect((await call(env, args)).isError).toBe(true)
    expect(env.ctx.agents.list()).toEqual([env.parent])
    expect(env.b.requests).toEqual([])
  })

  it('rejects another parent even when it knows a native child id', async () => {
    const env = await fixture()
    env.replaceAdapter('a', new PolicyAdapter([textResponse('first')]))
    const [id] = childIds(await call(env, { agent: 'reviewer', task: 'work' }))
    await settled(env.ctx, id!)
    const { agent: stranger } = await env.ctx.agents.create({ sessionId: SessionId('stranger') })
    expect((await call(env, { agent: 'reviewer', task: 'continue', resume: id }, stranger)).isError).toBe(true)
    expect(env.ctx.agents.get(id!)).toBeUndefined()
  })
})
