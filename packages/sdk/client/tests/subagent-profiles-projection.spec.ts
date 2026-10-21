/** Raw child-setup/profile records survive SDK delivery without changing final text. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-subagent-profiles'
import { createProcessDeepSeekHarness } from '../src/api.ts'

const expectedPath = fileURLToPath(new URL('./expected/subagent-profiles-projection.json', import.meta.url))
const fakeRuntime = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))
function isProfileRecord(value: unknown): boolean {
  return value !== null && typeof value === 'object' && 'type' in value
    && (value.type === 'subagent/descriptor' || value.type === 'subagent/profile' || value.type === 'subagent/profile-route')
}

it('preserves restorable child setup and route selection in raw SDK events', async () => {
  const expected = JSON.parse(await readFile(expectedPath, 'utf8')) as { finalResponse: string; profileEvents: SessionEvent[] }
  const ctx = new Context()
  const records: SessionEvent[] = []
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('sdk-profile-child'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    ctx.on('session/event', (_session, event) => { if (isProfileRecord(event)) records.push(event) })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    try {
      session.append('subagent/descriptor', { version: 4, mode: 'continuable', provider: 'spawn', label: 'Review', childSetup: 'markdown-profile' })
      session.append('subagent/profile', { name: 'reviewer', description: 'Review', source: 'user', persona: 'Review {{literal}}.', tools: [],
        routes: [{ provider: 'first', model: 'one' }, { provider: 'second', model: 'two' }] })
      session.append('subagent/profile-route', { index: 1 })
    } finally {
      clock.mockRestore()
    }
  } finally {
    await ctx.fiber.dispose()
  }
  expect(records).toEqual(expected.profileEvents)
  const harness = createProcessDeepSeekHarness({ command: process.execPath, args: [fakeRuntime],
    environment: () => ({ ...process.env, FAKE_TEXT: expected.finalResponse, FAKE_SESSION_EVENTS: JSON.stringify(records) }),
    description: 'scripted SDK profile projection', initializeTimeoutMs: 5000,
  })
  try {
    const result = await harness.run('Continue the recorded child.')
    const projection = {
      finalResponse: result.finalResponse,
      profileEvents: result.events.filter(isProfileRecord),
      profileNotifications: result.notifications.filter(notification => notification.method === 'session.event' && isProfileRecord(notification.params.event)).map((notification) => {
        if (notification.method !== 'session.event') throw new Error('Expected Session event notification')
        expect(notification.params.sessionId).toBe(result.sessionId)
        return { method: notification.method, event: notification.params.event }
      }),
      assistantTexts: result.events.filter(event => event.type === 'assistant/message')
        .flatMap(event => event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])),
    }
    expect(projection).toEqual(JSON.parse(await readFile(expectedPath, 'utf8')))
  } finally {
    await harness.close()
  }
})
