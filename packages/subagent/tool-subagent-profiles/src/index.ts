/** Opt-in Markdown profile delegation over the native Harness subagent lifecycle.
 * @module @deepseek-ai/dsh-tool-subagent-profiles
 */
export type {} from './state.ts'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition, JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { discoverProfiles } from './profiles.ts'
import { registerProfileRuntime } from './runtime.ts'
import { delegationRequestSchema, executeDelegation } from './delegate.ts'
import type { ProfileToolSpec } from './types.ts'

export const name = 'tool-subagent-profiles'
export const inject = ['agents', 'llm', 'tools', 'subagents', 'systemPrompt', 'sessionProjections', 'sessionQuery', 'workingDirectory', 'fs']

/** Operator-owned discovery, fresh-child provider, and optional base preset. */
export interface Config {
  /** Unique model-facing tool name. */
  toolName?: string
  /** Registered local provider that creates fresh child histories. */
  provider?: string
  /** Explicit Host directory replacing $DSH_HOME/agents. */
  userDirectory?: string
  /** Permit definitions under the original project's .dsh/agents. */
  includeProjectAgents?: boolean
  /** Optional native base preset; omission retains native parent composition. */
  agentPreset?: string
  /** Nonnegative safe integer; omission reads the native subagent depth setting. */
  maxDepth?: number
}

export const Config: z<Config> = z.object({
  toolName: z.string().min(1).default('subagent_profiles'), provider: z.string().min(1).default('spawn'),
  userDirectory: z.string().min(1), includeProjectAgents: z.boolean().default(false),
  agentPreset: z.string().min(1), maxDepth: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
})

function resolveConfig(config: Config): ProfileToolSpec {
  const parsed = Config(config)
  return { toolName: parsed.toolName ?? 'subagent_profiles', provider: parsed.provider ?? 'spawn',
    userDirectory: parsed.userDirectory === undefined ? dshHomePath('agents') : resolve(parsed.userDirectory),
    userDirectoryExplicit: parsed.userDirectory !== undefined, includeProjectAgents: parsed.includeProjectAgents ?? false,
    ...parsed.agentPreset === undefined ? {} : { agentPreset: parsed.agentPreset },
    ...parsed.maxDepth === undefined ? {} : { maxDepth: parsed.maxDepth },
  }
}

function assertProvider(provider: SubagentProvider, spec: ProfileToolSpec): void {
  if (provider.prepareContinuable === undefined || provider.inheritsParentContext || !provider.capabilities.agentOptions) {
    throw new Error(`Markdown profiles require a fresh local child provider with model selection; "${provider.name}" is incompatible`)
  }
  if (!provider.capabilities.depthLimit) throw new Error(`Profile provider "${provider.name}" does not support the native depth limit`)
  if (spec.agentPreset !== undefined && !provider.capabilities.agentPreset) {
    throw new Error(`Profile provider "${provider.name}" does not support independent presets`)
  }
}

const entryProperties: Record<string, JsonSchemaNode> = {
  agent: { type: 'string', description: 'Name from the available Markdown agents.' },
  task: { type: 'string', description: 'Self-contained task; chains replace {previous} with the prior successful final text.' },
  cwd: { type: 'string', description: 'Initial directory; relative paths use the parent current directory.' },
}
const entrySchema: JsonSchemaNode = { type: 'object', properties: entryProperties, required: ['agent', 'task'], additionalProperties: false }

/**
 * Register the optional tool, durable child setup, and asynchronous catalog guidance.
 * @param ctx - Host plugin context owning every registration and active invocation.
 * @param config - operator discovery, provider, preset, and depth settings.
 */
export function apply(ctx: Context, config: Config): void {
  const spec = resolveConfig(config)
  const present = ctx.subagents.getProvider(spec.provider)
  if (present === undefined) throw new Error(`Markdown profile provider "${spec.provider}" is not registered; mount the spawn provider first`)
  assertProvider(present, spec)
  const lifetime = registerProfileRuntime(ctx)
  const active = new Set<Promise<unknown>>()
  const definition: ToolDefinition = {
    name: spec.toolName,
    description: 'Delegate to named Markdown agents using exactly one mode: agent/task, tasks, or chain. Single and parallel calls return native child ids immediately; chains wait. Resume with agent/task/resume to retain the recorded profile.',
    parameters: { type: 'object', properties: {
      ...entryProperties,
      resume: { type: 'string', description: 'Native child Session id belonging to you; single mode only, without cwd.' },
      tasks: { type: 'array', items: entrySchema, description: 'Start these independent tasks together after all entries pass preflight.' },
      chain: { type: 'array', items: entrySchema, description: 'Run sequentially, substituting {previous}; stop on the first untrusted or unsuccessful result.' },
    }, additionalProperties: false },
    isConcurrencySafe: () => true,
    output: { schema: { type: 'object', properties: { kind: { type: 'string', enum: ['activations', 'chain', 'continued'] } }, required: ['kind'], additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => {
      const request = delegationRequestSchema.parse(args)
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      const operation = executeDelegation(ctx, spec, request, exec, signal)
      active.add(operation)
      return operation.finally(() => { active.delete(operation) })
    },
  }
  let unmount: (() => void) | undefined
  const mount = (provider: SubagentProvider): void => {
    assertProvider(provider, spec)
    unmount = ctx.tools.register(definition)
  }
  mount(present)
  ctx.on('subagent/provider-added', (provider) => { if (provider.name === spec.provider) mount(provider) })
  ctx.on('subagent/provider-removed', (provider) => {
    if (provider !== spec.provider) return
    unmount?.()
    unmount = undefined
  })
  const sectionName = `tool:${spec.toolName}:profiles`
  ctx.systemPrompt.section({ name: sectionName, order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'), text: '', interpolate: false })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (unmount === undefined || ctx.tools.get(spec.toolName, context.scope) !== definition) return assembly
    const signal = context.signal === undefined ? lifetime.signal : AbortSignal.any([context.signal, lifetime.signal])
    const catalog = await discoverProfiles({ ...spec,
      ...context.agent?.session.header.cwd === undefined ? {} : { projectDirectory: context.agent.session.header.cwd },
    }, signal)
    const agents = [...catalog.profiles.values()].map(profile => `- ${profile.name}: ${profile.description}`).join('\n')
    const text = `Markdown agents for ${spec.toolName}:\n${agents || '(none configured)'}`
      + (catalog.diagnostics.length === 0 ? '' : `\n${catalog.diagnostics.join('\n')}`)
    return { ...assembly, sections: assembly.sections.map(section => section.name === sectionName
      ? { ...section, text, interpolate: false } : section) }
  })
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Markdown profile tool unloaded'))
    unmount?.()
    unmount = undefined
    await Promise.allSettled([...active])
  }, 'profile tool invocation teardown')
}
