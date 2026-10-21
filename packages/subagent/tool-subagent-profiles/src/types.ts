/** Markdown profile data, durable snapshots, and delegation inputs.
 * @module @deepseek-ai/dsh-tool-subagent-profiles/types
 */
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** Exact physical route with route-owned reasoning effort. */
export type ProfileRoute = {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: ReasoningEffortId
}

/** One validated Markdown definition, before provider resolution. */
export interface ParsedProfile {
  readonly name: string
  readonly description: string
  readonly source: 'user' | 'project'
  readonly filePath: string
  readonly persona: string
  readonly tools?: string[]
  readonly routes?: ProfileRoute[]
  readonly diagnostics: string[]
}

/** Operator-resolved directories and project trust for one discovery. */
export interface ProfileDiscoverySpec {
  readonly userDirectory: string
  readonly userDirectoryExplicit: boolean
  readonly includeProjectAgents: boolean
  readonly projectDirectory?: string
}

/** Deterministically ordered definitions with diagnostic-only metadata. */
export interface ProfileCatalog {
  readonly profiles: Map<string, ParsedProfile>
  readonly diagnostics: string[]
}

/** Child-owned instructions and nonempty resolved routing chain, without credentials. */
export type SubagentProfileSnapshot = {
  readonly name: string
  readonly description: string
  readonly source: 'user' | 'project'
  readonly persona: string
  readonly tools?: string[]
  readonly routes: ProfileRoute[]
}

/** Persisted profile with the currently selected route index. */
export interface SubagentProfileState {
  readonly inheritedEventCount: number
  readonly retryStarts: number
  readonly snapshot: SubagentProfileSnapshot | null
  readonly index: number
}

/** A named task for one native child. */
export interface DelegationEntry {
  readonly agent: string
  readonly task: string
  readonly cwd?: string
}

/** Exactly one single, parallel, or sequential delegation mode. */
export type DelegationRequest =
  | (DelegationEntry & { readonly resume?: string })
  | { readonly tasks: DelegationEntry[] }
  | { readonly chain: DelegationEntry[] }

/** Validated deployment settings with explicit runtime defaults. */
export interface ProfileToolSpec {
  readonly toolName: string
  readonly provider: string
  readonly userDirectory: string
  readonly userDirectoryExplicit: boolean
  readonly includeProjectAgents: boolean
  readonly agentPreset?: string
  readonly maxDepth?: number
}
