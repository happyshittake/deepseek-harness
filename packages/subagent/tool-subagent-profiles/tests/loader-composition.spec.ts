/** Real Loader Config, runtime ordering, and effect-owned tool availability. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished } from 'vitest'
import * as Profiles from '../src/index.ts'
import { setup, settled, PolicyAdapter, failure } from './harness.ts'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import { fixture, call, childIds } from './tool-harness.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

it('loads the actual plugin namespace through Loader with validated defaults', async () => {
  const { ctx, parent } = await setup()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-profiles-loader-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'agent.md'), '---\nname: reviewer\ndescription: Review\n---\nReview.')
  await ctx.plugin(Loader)
  ctx.loader.builtins['profiles-test'] = Profiles
  const entryId = await ctx.loader.create({ name: 'cordis:profiles-test', config: { userDirectory: directory } })
  await ctx.loader.await()
  const entry = ctx.loader.resolve(entryId)
  expect(entry.fiber).toBeDefined()
  expect(ctx.tools.get('subagent_profiles')).toBeDefined()
  const result = await ctx.tools.execute({ agent: parent, signal: new AbortController().signal,
    name: 'subagent_profiles', callId: ToolCallId('loader'), arguments: { agent: 'reviewer', task: 'Review now' } })
  expect(result.isError).toBe(false)
  const [id] = childIds(result)
  await settled(ctx, id!)
  await entry.fiber?.dispose()
  expect(ctx.tools.get('subagent_profiles')).toBeUndefined()
})

it.each([{ maxDepth: -1 }, { maxDepth: 0.5 }, { toolName: '' }, { userDirectory: '' }, { includeProjectAgents: 'yes' }])('rejects invalid operator Config: %j', (config) => {
  expect(() => Profiles.Config(config as never)).toThrow()
})

it.each([false, true])('routes admitted fallback through real Loader rows (profile first: %s)', async (profileFirst) => {
  const { ctx, parent, retry } = await setup()
  await retry.dispose()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-profiles-loader-order-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'agent.md'), '---\nname: reviewer\ndescription: Review\nmodel: a/one, b/two\n---\nReview.')
  const a = new PolicyAdapter([failure()])
  const b = new PolicyAdapter([textResponse('recovered')])
  ctx.llm.registerAdapter(['a'], a)
  ctx.llm.registerAdapter(['b'], b)
  await ctx.plugin(Loader)
  ctx.loader.builtins['profiles-order'] = Profiles
  ctx.loader.builtins['retry-order'] = Retry
  const profile = { name: 'cordis:profiles-order', config: { userDirectory: directory } }
  const recovery = { name: 'cordis:retry-order' }
  for (const row of profileFirst ? [profile, recovery] : [recovery, profile]) await ctx.loader.create(row)
  await ctx.loader.await()
  const result = await ctx.tools.execute({ agent: parent, signal: new AbortController().signal,
    name: 'subagent_profiles', callId: ToolCallId('loader-order'),
    arguments: { chain: [{ agent: 'reviewer', task: 'Review now' }] },
  })
  expect(result.value).toMatchObject({ kind: 'chain', status: 'completed', output: 'recovered' })
  const [id] = childIds(result)
  const stored = await settled(ctx, id!)
  expect(stored.events.filter(event => event.type === 'subagent/profile-route').map(event => event.data)).toEqual([{ index: 1 }])
  expect(a.requests).toHaveLength(1)
  expect(b.requests).toHaveLength(1)
})

it.each(['preset', 'depth'] as const)('rejects an incompatible configured provider at mount: %s', async (kind) => {
  const { ctx } = await setup()
  ctx.subagents.registerProvider({
    name: 'limited', inheritsParentContext: false,
    capabilities: { agentOptions: true, outputSchema: false, agentPreset: kind !== 'preset', depthLimit: kind !== 'depth' },
    prepareContinuable: () => Promise.resolve({}),
  })
  await expect(ctx.plugin(Profiles, { provider: 'limited', ...kind === 'preset' ? { agentPreset: 'child' } : { maxDepth: 2 } }))
    .rejects.toThrow(kind === 'preset' ? 'does not support independent presets' : 'does not support the native depth limit')
  expect(ctx.tools.get('subagent_profiles')).toBeUndefined()
})

it('retains child restoration independently of provider unload and remounts its tool on reload', async () => {
  const env = await fixture()
  env.replaceAdapter('a', new PolicyAdapter([textResponse('first'), textResponse('continued')]))
  const [id] = childIds(await call(env, { agent: 'reviewer', task: 'work' }))
  await settled(env.ctx, id!)
  await env.spawn.dispose()
  expect(env.ctx.tools.get('subagent_profiles')).toBeUndefined()
  await env.ctx.subagents.sendMessage(env.parent, id!, [{ type: 'text', text: 'continue' }], { signal: new AbortController().signal })
  await settled(env.ctx, id!)
  await env.ctx.plugin(Spawn, { providerName: 'spawn' })
  expect(env.ctx.tools.get('subagent_profiles')).toBeDefined()
  await env.plugin.dispose()
  expect(env.ctx.tools.get('subagent_profiles')).toBeUndefined()
})
