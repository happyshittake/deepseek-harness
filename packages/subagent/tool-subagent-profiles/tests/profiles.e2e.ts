/** Key-gated native profile delegation against the configured real DeepSeek route. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { spawnHarness } from '../../subagent-spawn-in-process/tests/harness.ts'
import { TestSessionQuery } from '../../subagent/tests/test-session-query.ts'
import * as Profiles from '../src/index.ts'

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('native Markdown profiles with a real provider', () => {
  it('uses a restricted profile to write a file and returns trusted chain text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profiles-e2e-'))
    const ctx = await spawnHarness(root)
    try {
      await writeFile(join(root, 'writer.md'), '---\nname: writer\ndescription: Write a small file\ntools: bash\nmodel: deepseek-official/deepseek-v4-flash\n---\nUse bash to complete the requested filesystem task, then report DONE.')
      await ctx.plugin(TestSessionQuery)
      await ctx.plugin(Profiles, { userDirectory: root })
      const parent = await ctx.agentLoop.create(SessionId('profiles-e2e-parent'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, { cwd: root })
      const result = await ctx.tools.execute({ agent: parent, signal: new AbortController().signal,
        name: 'subagent_profiles', callId: ToolCallId('profile-e2e'), arguments: {
          chain: [{ agent: 'writer', task: 'Write exactly PROFILE_NATIVE to native.txt in the current directory, then reply DONE.' }],
        },
      })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ kind: 'chain', status: 'completed' })
      expect(await readFile(join(root, 'native.txt'), 'utf8')).toContain('PROFILE_NATIVE')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
