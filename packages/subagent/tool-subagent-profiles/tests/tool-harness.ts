/** Shared real-tool fixtures for delegation and continuation tests. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { onTestFinished } from 'vitest'
import { z } from 'zod'
import { setup, PolicyAdapter } from './harness.ts'
import * as Profiles from '../src/index.ts'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Real tool installation with temporary operator-owned definitions. */
export async function fixture() {
  const env = await setup()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-profile-tool-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'reviewer.md'), '---\nname: reviewer\ndescription: Review changes\nmodel: a/one\n---\nReviewer persona.')
  await writeFile(join(directory, 'scout.md'), '---\nname: scout\ndescription: Scout files\nmodel: b/two\n---\nScout persona.')
  const plugin = await env.ctx.plugin(Profiles, { userDirectory: directory })
  const a = new PolicyAdapter(['hang', 'hang'])
  const b = new PolicyAdapter(['hang', 'hang'])
  const registrations = new Map([
    ['a', env.ctx.llm.registerAdapter(['a'], a)], ['b', env.ctx.llm.registerAdapter(['b'], b)],
  ])
  const replaceAdapter = (provider: string, adapter: PolicyAdapter): void => {
    registrations.get(provider)?.()
    registrations.set(provider, env.ctx.llm.registerAdapter([provider], adapter))
  }
  return { ...env, directory, plugin, a, b, replaceAdapter }
}

/** Execute the actual registered tool with an exact live caller. */
export function call(
  env: Awaited<ReturnType<typeof fixture>>, args: unknown, agent: Agent = env.parent, signal = new AbortController().signal,
) {
  return env.ctx.tools.execute({ name: 'subagent_profiles', callId: ToolCallId('delegate'), arguments: args, signal, agent })
}

/** Decode dynamic native ids without deriving expected behavior from the implementation. */
export function childIds(result: ToolExecutionResult) {
  const parsed = z.object({ children: z.array(z.object({ childId: z.string() })) }).parse(result.value)
  return parsed.children.map(child => SessionId(child.childId))
}
