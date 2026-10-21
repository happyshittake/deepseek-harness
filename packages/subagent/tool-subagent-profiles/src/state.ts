/** Required child profile records and their host-only projection.
 * @module @deepseek-ai/dsh-tool-subagent-profiles/state
 */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SubagentProfileSnapshot, SubagentProfileState } from './types.ts'

/** Validation of persisted profile instructions and physical routing choices. */
export const profileSnapshotSchema: z.ZodType<SubagentProfileSnapshot> = z.object({
  name: z.string().min(1), description: z.string().min(1), source: z.enum(['user', 'project']),
  persona: z.string(), tools: z.array(z.string().min(1)).optional(),
  routes: z.array(z.object({
    provider: z.string().min(1), model: z.string().min(1),
    reasoningEffort: z.string().min(1).transform(ReasoningEffortId).optional(),
  }).strict().transform(({ reasoningEffort, ...route }) => ({
    ...route, ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }))).min(1),
}).strict().transform(({ tools, ...profile }) => ({ ...profile, ...tools === undefined ? {} : { tools } }))

const routeSchema = z.object({ index: z.number().int().nonnegative() }).strict()
const stateSchema: z.ZodType<SubagentProfileState> = z.object({
  inheritedEventCount: z.number().int().nonnegative(), retryStarts: z.number().int().nonnegative(),
  snapshot: profileSnapshotSchema.nullable(), index: z.number().int().nonnegative(),
}).strict().refine(state => state.snapshot === null ? state.index === 0 : state.index < state.snapshot.routes.length,
  'profile route index is outside the recorded chain')

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Child-owned immutable instructions and routes, required before the first request. */
    'subagent/profile': SubagentProfileSnapshot
    /** Complete selected-route index after a provider-admitted retry; required on read. */
    'subagent/profile-route': { readonly index: number }
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Child-owned profile and provider-admitted retry evidence. */
    subagentProfile: SubagentProfileState
  }
}

/**
 * Read mandatory profile state without a missing-plugin fallback.
 * @param ctx - context containing the registered host projection.
 * @param session - child Session whose committed records are authoritative.
 * @returns validated profile state, or throws when its projection is unavailable.
 */
export function readProfileState(ctx: Context, session: Session): SubagentProfileState {
  const state = ctx.sessionProjections.stateOf(session, 'subagentProfile')
  if (state === undefined) throw new Error('Markdown profile projection is unavailable')
  return state
}

/** Validates profile records and ignores fork-inherited ancestors' instructions. */
export const profileProjection: ProjectionDefinition<'subagentProfile'> = {
  key: 'subagentProfile', stateVersion: 1, stateSchema,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, retryStarts: 0, snapshot: null, index: 0 }),
  apply: (state, event) => {
    if (event.seq < state.inheritedEventCount) return state
    if (event.type === 'subagent/profile') {
      if (state.snapshot !== null) throw new Error('duplicate child profile snapshot')
      return { ...state, snapshot: profileSnapshotSchema.parse(event.data) }
    }
    if (event.type === 'subagent/profile-route') {
      const { index } = routeSchema.parse(event.data)
      if (state.snapshot === null || index !== state.index + 1 || index >= state.snapshot.routes.length) {
        throw new Error('invalid profile route transition')
      }
      return { ...state, index }
    }
    if (event.type === 'llm/retry-started' && state.snapshot !== null) {
      return { ...state, retryStarts: state.retryStarts + 1 }
    }
    return state
  },
}
