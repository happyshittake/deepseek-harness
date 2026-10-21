/** Safe Markdown frontmatter parsing and opt-in project discovery.
 * @module @deepseek-ai/dsh-tool-subagent-profiles/profiles
 */
import { readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { JSON_SCHEMA, load } from 'js-yaml'
import { z } from 'zod'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ParsedProfile, ProfileCatalog, ProfileDiscoverySpec, ProfileRoute } from './types.ts'

const efforts = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const fields = new Set(['name', 'description', 'tools', 'model'])
const frontmatter = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  tools: z.union([z.string(), z.array(z.string().trim().min(1))]).optional(),
  model: z.string().trim().min(1).optional(),
}).loose()

function commaList(value: string): string[] {
  const entries = value.split(',').map(entry => entry.trim())
  if (entries.some(entry => entry.length === 0)) throw new Error('remove empty comma-separated entries')
  return entries
}

function route(reference: string): ProfileRoute {
  const slash = reference.indexOf('/')
  if (slash <= 0 || slash === reference.length - 1) throw new Error(`model "${reference}" must use provider/model`)
  const provider = reference.slice(0, slash)
  const remainder = reference.slice(slash + 1)
  const colon = remainder.lastIndexOf(':')
  const suffix = remainder.slice(colon + 1)
  if (colon >= 0 && efforts.has(suffix)) {
    const model = remainder.slice(0, colon)
    if (model.length === 0) throw new Error('model id must not be empty before an effort suffix')
    return { provider, model, reasoningEffort: ReasoningEffortId(suffix) }
  }
  return { provider, model: remainder }
}

/**
 * Parse a compatible definition without executing YAML tags or prompt templates.
 * @param text - complete Markdown file contents.
 * @param filePath - source path included in actionable failures.
 * @param source - operator-authorized discovery scope.
 * @returns validated instructions, routes, restrictions, and inert-metadata diagnostics.
 */
export function parseProfile(text: string, filePath: string, source: 'user' | 'project'): ParsedProfile {
  try {
    const contents = text.replace(/^\uFEFF/, '')
    const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(contents)
    if (match === null) throw new Error('add YAML frontmatter delimited by ---')
    const metadata: unknown = load(match[1] as string, { schema: JSON_SCHEMA })
    const parsed = frontmatter.parse(metadata)
    const tools = typeof parsed.tools === 'string'
      ? parsed.tools.trim() === '' ? [] : commaList(parsed.tools)
      : parsed.tools
    const ignored = Object.keys(parsed).filter(key => !fields.has(key)).sort()
    return {
      name: parsed.name, description: parsed.description, source, filePath,
      persona: contents.slice(match[0].length),
      ...tools === undefined ? {} : { tools },
      ...parsed.model === undefined ? {} : { routes: commaList(parsed.model).map(route) },
      diagnostics: ignored.map(key => `${filePath}: metadata "${key}" has no Harness effect`),
    }
  } catch (error: unknown) {
    throw new Error(`Invalid agent profile ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

function withinProject(project: string, path: string): void {
  const part = relative(project, path)
  if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) {
    throw new Error(`agent profile path ${path} escapes the original project ${project}`)
  }
}

async function scopeProfiles(directory: string, source: 'user' | 'project', required: boolean, signal: AbortSignal, project?: string): Promise<ParsedProfile[]> {
  signal.throwIfAborted()
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (!required && error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw new Error(`Cannot read agent profiles directory ${directory}; check the configured path and permissions`, { cause: error })
  }
  const projectRoot = project === undefined ? undefined : await realpath(project)
  if (projectRoot !== undefined) withinProject(projectRoot, await realpath(directory))
  const profiles: ParsedProfile[] = []
  const names = new Set<string>()
  for (const name of entries.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md')).map(entry => entry.name).sort()) {
    signal.throwIfAborted()
    const path = join(directory, name)
    if (projectRoot !== undefined) withinProject(projectRoot, await realpath(path))
    let text: string
    try {
      text = await readFile(path, { encoding: 'utf8', signal })
    } catch (error: unknown) {
      signal.throwIfAborted()
      throw new Error(`Cannot read agent profile ${path}; check file permissions`, { cause: error })
    }
    const profile = parseProfile(text, path, source)
    if (names.has(profile.name)) throw new Error(`Duplicate agent profile "${profile.name}" in ${directory}`)
    names.add(profile.name)
    profiles.push(profile)
  }
  return profiles
}

/**
 * Discover only operator-approved directories; project definitions override user names.
 * @param spec - resolved directory paths and explicit project trust.
 * @param signal - cancellation for discovery and file reads.
 * @returns ordered definitions and metadata diagnostics, without caching file contents.
 */
export async function discoverProfiles(spec: ProfileDiscoverySpec, signal: AbortSignal): Promise<ProfileCatalog> {
  const user = await scopeProfiles(spec.userDirectory, 'user', spec.userDirectoryExplicit, signal)
  const project = spec.includeProjectAgents && spec.projectDirectory !== undefined
    ? await scopeProfiles(join(spec.projectDirectory, '.dsh', 'agents'), 'project', false, signal, spec.projectDirectory)
    : []
  const profiles = new Map<string, ParsedProfile>()
  for (const profile of [...user, ...project]) profiles.set(profile.name, profile)
  signal.throwIfAborted()
  return { profiles, diagnostics: [...user, ...project].flatMap(profile => profile.diagnostics) }
}
