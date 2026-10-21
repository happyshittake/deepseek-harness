/** Markdown compatibility, deterministic discovery, and project trust. */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { discoverProfiles, parseProfile } from '../src/profiles.ts'

const signal = new AbortController().signal
const markdown = (fields = '', body = 'Review {{literal}}.\n') => `---\nname: reviewer\ndescription: Review changes\n${fields}---\n${body}`

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'dsh-markdown-profiles-'))
  onTestFinished(() => rm(path, { recursive: true, force: true }))
  return path
}

async function file(directory: string, name: string, text = markdown()) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, name), text)
}

describe('parseProfile', () => {
  it('loads four-field profiles, inner model slashes, efforts and literal persona', () => {
    const profile = parseProfile(markdown('tools: read, bash\nmodel: gateway/vendor/model:high, backup/model\n'), 'reviewer.md', 'user')
    expect(profile).toMatchObject({
      name: 'reviewer', description: 'Review changes', tools: ['read', 'bash'],
      persona: 'Review {{literal}}.\n', source: 'user', filePath: 'reviewer.md',
      routes: [{ provider: 'gateway', model: 'vendor/model', reasoningEffort: 'high' }, { provider: 'backup', model: 'model' }],
      diagnostics: [],
    })
  })

  it.each([
    ['tools: [read, bash]\n', ['read', 'bash']],
    ['tools: []\n', []],
    ['tools: ""\n', []],
  ])('preserves explicit tool lists: %s', (fields, tools) => {
    expect(parseProfile(markdown(fields), 'profile.md', 'user').tools).toEqual(tools)
  })

  it('distinguishes omitted tools/model and reports inert metadata without applying it', () => {
    const profile = parseProfile(markdown('extensions: [other]\nskills: [plan]\nmcp: {}\ncodemode: true\ninherit_context: true\nprompt_mode: replace\n'), 'profile.md', 'user')
    expect(profile.tools).toBeUndefined()
    expect(profile.routes).toBeUndefined()
    expect(profile.diagnostics.join(' ')).toMatch(/extensions.*no Harness effect/)
    expect(profile.diagnostics.join(' ')).toContain('prompt_mode')
  })

  it('accepts BOM and CRLF while preserving non-ASCII body text', () => {
    const body = '审查 {{name}}。\r\n'
    expect(parseProfile('\uFEFF' + markdown('', body).replace(/(?<!\r)\n/g, '\r\n'), 'p.md', 'project').persona).toBe(body)
  })

  it.each(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])('recognizes effort %s', (effort) => {
    expect(parseProfile(markdown(`model: provider/model:${effort}\n`), 'p.md', 'user').routes)
      .toEqual([{ provider: 'provider', model: 'model', reasoningEffort: effort }])
  })

  it('leaves unrecognized colon suffixes inside model ids', () => {
    expect(parseProfile(markdown('model: provider/model:v2\n'), 'p.md', 'user').routes)
      .toEqual([{ provider: 'provider', model: 'model:v2' }])
  })

  it.each([
    'tools: false\n', 'tools: null\n', 'tools: [read, 4]\n', 'tools: [""]\n', 'tools: read,,bash\n',
    'model: [provider/model]\n', 'model: ""\n', 'model: provider/model,\n',
    'model: /model\n', 'model: provider/\n', 'model: model\n',
    'tools: !!js/function function() {}\n', 'tools: [read\n',
  ])('rejects malformed supported fields with the source path: %s', (fields) => {
    expect(() => parseProfile(markdown(fields), '/profiles/bad.md', 'user')).toThrow(/\/profiles\/bad.md/)
  })

  it.each(['no frontmatter', '---\nname: only\n---\nbody', '---\nname: ""\ndescription: x\n---\n'])('requires frontmatter and nonempty identity: %s', (text) => {
    expect(() => parseProfile(text, 'bad.md', 'user')).toThrow(/bad.md/)
  })
})

describe('discoverProfiles', () => {
  it('does not read project agents without operator opt-in and allows explicit overrides', async () => {
    const path = await root()
    const userDirectory = join(path, 'user')
    const projectDirectory = join(path, 'project')
    await file(userDirectory, 'review.md')
    await file(join(projectDirectory, '.dsh/agents'), 'review.md', markdown('', 'Project instructions.'))
    const spec = { userDirectory, userDirectoryExplicit: true, projectDirectory, includeProjectAgents: false }
    expect((await discoverProfiles(spec, signal)).profiles.get('reviewer')?.persona).toBe('Review {{literal}}.\n')
    expect((await discoverProfiles({ ...spec, includeProjectAgents: true }, signal)).profiles.get('reviewer')?.persona)
      .toBe('Project instructions.')
  })

  it('sorts files deterministically, ignores unrelated files, and rejects same-scope duplicates', async () => {
    const path = await root()
    await file(path, 'z.md', markdown().replace('reviewer', 'z'))
    await file(path, 'a.md', markdown().replace('reviewer', 'a'))
    await file(path, 'ignored.txt', 'not a profile')
    const spec = { userDirectory: path, userDirectoryExplicit: true, includeProjectAgents: false }
    expect([...(await discoverProfiles(spec, signal)).profiles.keys()]).toEqual(['a', 'z'])
    await file(path, 'duplicate.md', markdown().replace('reviewer', 'a'))
    await expect(discoverProfiles(spec, signal)).rejects.toThrow(/duplicate.*a/i)
  })

  it('tolerates missing default directories but rejects explicitly configured missing paths', async () => {
    const userDirectory = join(await root(), 'absent')
    const spec = { userDirectory, userDirectoryExplicit: false, includeProjectAgents: true, projectDirectory: userDirectory }
    expect((await discoverProfiles(spec, signal)).profiles.size).toBe(0)
    await expect(discoverProfiles({ ...spec, userDirectoryExplicit: true }, signal)).rejects.toThrow(userDirectory)
    await writeFile(userDirectory, 'not a directory')
    await expect(discoverProfiles(spec, signal)).rejects.toThrow(userDirectory)
  })

  it('refuses project file and directory symlinks escaping the original project', async () => {
    const path = await root()
    const projectDirectory = join(path, 'project')
    const outside = join(path, 'outside')
    await file(outside, 'review.md')
    const agents = join(projectDirectory, '.dsh/agents')
    await mkdir(agents, { recursive: true })
    await symlink(join(outside, 'review.md'), join(agents, 'escape.md'))
    const spec = { userDirectory: join(path, 'missing'), userDirectoryExplicit: false, projectDirectory, includeProjectAgents: true }
    await expect(discoverProfiles(spec, signal)).rejects.toThrow(/escapes.*project/)
    await rm(agents, { recursive: true })
    await symlink(outside, agents)
    await expect(discoverProfiles(spec, signal)).rejects.toThrow(/escapes.*project/)
  })

  it('honors cancellation before filesystem work', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(discoverProfiles({ userDirectory: '/unused', userDirectoryExplicit: false, includeProjectAgents: false }, controller.signal))
      .rejects.toThrow('cancelled')
  })
})
