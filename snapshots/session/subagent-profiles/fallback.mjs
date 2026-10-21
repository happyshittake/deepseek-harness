/** Fail one child request after its write, then check physical fallback and retained history. */
import assert from 'node:assert/strict'

export const name = 'profile-fallback-fixture'
export const inject = ['agents', 'llm']

/**
 * Inject a transient transport failure at the real streaming operation.
 * @param {import('@deepseek-ai/cordis').Context} ctx - scenario-owned Host context.
 */
export function apply(ctx) {
  let failed = false
  let recovered = false
  ctx.on('llm/stream', async function* (options, next) {
    const agent = ctx.agents.get(options.sessionId)
    if (agent?.session.header.parentSession !== undefined) {
      const tools = options.messages.filter(message => message.role === 'tool')
      if (tools.length > 0 && !failed) {
        assert.equal(options.provider, 'deepseek-official')
        assert.equal(options.model, 'deepseek-v4-flash')
        for await (const _chunk of next()) { /* Consume the fixture attempt being replaced. */ }
        failed = true
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'authored transient outage after write', code: 'SERVER' } } }
        return
      }
      if (failed) {
        assert.equal(options.provider, 'deepseek-messages')
        assert.equal(options.model, 'deepseek-v4-pro')
        assert.equal(tools.length, 1)
        assert.match(JSON.stringify(tools[0]), /Created file/)
        recovered = true
      }
    }
    if (agent?.session.header.parentSession === undefined
      && options.messages.some(message => message.source?.kind === 'subagent-settled')) {
      assert.equal(failed, true, 'The completion notice requires the failure after the write')
      assert.equal(recovered, true, 'The completion notice requires the physical fallback route')
    }
    yield* next()
  })
}
