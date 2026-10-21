/** Profile snapshots and route choices are validated, child-owned Session state. */
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { expect, it, onTestFinished } from 'vitest'
import { profileProjection, profileSnapshotSchema, readProfileState } from '../src/state.ts'

const snapshot = { name: 'reviewer', description: 'Review', source: 'user' as const, persona: '{{literal}}', routes: [{ provider: 'a', model: 'one' }, { provider: 'b', model: 'two' }] }

async function setup() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Projections)
  ctx.sessionProjections.register(profileProjection)
  const session = Session.create(SessionId('child'))
  return { ctx, session }
}

it('requires its registered projection instead of silently defaulting profile state', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Projections)
  expect(() => readProfileState(ctx, Session.create(SessionId('no-projection')))).toThrow(/projection.*unavailable/)
})

it('folds a snapshot and exact next route while preserving instructions', async () => {
  const { ctx, session } = await setup()
  session.append('subagent/profile', snapshot)
  session.append('subagent/profile-route', { index: 1 })
  expect(ctx.sessionProjections.stateOf(session, 'subagentProfile')).toMatchObject({ snapshot, index: 1 })
  expect(profileSnapshotSchema.parse({ ...snapshot, tools: [] }).tools).toEqual([])
})

it.each(['duplicate', 'before', 'outside', 'repeat'] as const)('rejects inconsistent persisted state: %s', async (kind) => {
  const { ctx, session } = await setup()
  if (kind !== 'before') session.append('subagent/profile', snapshot)
  if (kind === 'duplicate') session.append('subagent/profile', snapshot)
  else session.append('subagent/profile-route', { index: kind === 'outside' ? 9 : kind === 'repeat' ? 0 : 1 })
  expect(() => ctx.sessionProjections.stateOf(session, 'subagentProfile')).toThrow(/profile|route/i)
})

it.each([{ ...snapshot, routes: [] }, { ...snapshot, tools: [4] }, { ...snapshot, source: 'unknown' }])('rejects invalid persisted snapshots', (candidate) => {
  expect(() => profileSnapshotSchema.parse(candidate)).toThrow()
})
