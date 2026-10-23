/**
 * multi-codex — several ChatGPT Codex OAuth accounts behind one DSH provider.
 *
 * Port of the pi extension `codex-multi.ts` to the DeepSeek Harness LLM seam:
 * one `multi-codex/<model>` route picks the least-assigned healthy account per
 * conversation, stays sticky for cache locality, and fails over across
 * accounts on pre-output rate-limit/auth failures. Accounts, auth tokens, and
 * the routing file are shared with pi through the pi agent directory, so pi
 * and DSH sessions reserve accounts from the same pool instead of racing.
 *
 * /multi-codex-auth login <label> [device]  — add/authenticate an account
 * /multi-codex-auth use <label|default>     — pin the account for this session
 * /multi-codex-auth list                    — show accounts + auth status
 * /multi-codex-auth cancel <label>          — abort a pending login
 *
 * auth.json writes (and token refresh) run under an `auth.json.lock` mkdir
 * lock — the same path pi's proper-lockfile uses — so concurrent pi sessions,
 * DSH sessions, and pi core itself serialize instead of clobbering each other.
 *
 * @module @local/multi-codex
 */

import { randomUUID } from 'crypto'
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, extname, join, resolve } from 'path'
import { setTimeout as sleep } from 'timers/promises'
import { spawn } from 'child_process'

import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import {
  createAssistantMessageEventStream,
  openAICodexResponsesApi,
} from '@earendil-works/pi-ai/compat'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'

export const name = 'multi-codex'
export const inject = ['llm', 'tools', 'commands']

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
const STATE_FILE = join(AGENT_DIR, 'multi-codex.json')
const AUTH_FILE = join(AGENT_DIR, 'auth.json')
const BASE_ID = 'openai-codex'
const PREFIX = 'openai-codex-'
const PROVIDER_ID = 'multi-codex'

// Errors worth switching accounts for (only retried pre-output, so safe).
const FAILOVER =
  /429|rate.?limit|too many requests|usage limit|quota|insufficient.*(credit|quota)|401|403|unauthori[sz]ed|invalid.?grant|forbidden/i

const LEASE_MS = 5 * 60_000

// Harness failure codes, mirroring @deepseek-ai/dsh-llm's error vocabulary so
// the retry executor and session surfaces classify failures the standard way.
const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
const QUOTA_EXCEEDED_CODE = 'QUOTA'
const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

// --- account state + auth.json (shared with pi) ---

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
  } catch {
    return { accounts: [] }
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 })
}

function readAuth() {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

// mkdir lock on the same path proper-lockfile uses; stale locks (crashed
// holder) are broken after 30s, matching pi's own acquire deadline.
async function withAuthLock(fn) {
  const lockDir = `${AUTH_FILE}.lock`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 })
      break
    } catch {
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 30_000) rmdirSync(lockDir)
      } catch {}
      if (Date.now() > deadline)
        throw new Error('[multi-codex] timed out waiting for auth.json lock')
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  try {
    const data = readAuth()
    const [result, next] = await fn(data)
    if (next) writeFileSync(AUTH_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
    return result
  } finally {
    try {
      rmdirSync(lockDir)
    } catch {}
  }
}

async function persistCredential(providerId, credential) {
  await withAuthLock((data) => {
    data[providerId] = credential
    return [undefined, data]
  })
}

function accountId(label) {
  return `${PREFIX}${label}`
}

function label(id) {
  return id === BASE_ID ? 'default' : id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id
}

function codexAccountsWithAuth() {
  const auth = readAuth()
  const ids = [BASE_ID, ...loadState().accounts.map(accountId)]
  return ids.filter((id) => auth[id]?.type === 'oauth')
}

// --- shared conversation reservations (same file pi uses) ---

function isMissing(error) {
  return error?.code === 'ENOENT'
}

// Publish a nonempty directory atomically: stale reclaimers can never remove
// an initializing holder. Unique markers protect successors during cleanup.
async function routingLock(file, signal) {
  signal?.throwIfAborted()
  const dir = `${file}.lock`
  const token = `owner-${process.pid}-${randomUUID()}`
  const staging = `${dir}.${randomUUID()}.tmp`
  const deadline = Date.now() + 30_000
  mkdirSync(staging, { mode: 0o700 })
  try {
    writeFileSync(join(staging, token), '', { mode: 0o600, flag: 'wx' })
    for (;;) {
      signal?.throwIfAborted()
      try {
        renameSync(staging, dir)
        return () => {
          unlinkSync(join(dir, token))
          try { rmdirSync(dir) } catch (error) {
            if (!isMissing(error) && error?.code !== 'ENOTEMPTY') throw error
          }
        }
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code ?? '')) throw error
      }
      try {
        const entries = readdirSync(dir)
        const pid = entries.length === 1 ? /^owner-(\d+)-/.exec(entries[0])?.[1] : undefined
        if (pid) {
          try { process.kill(Number(pid), 0) } catch (error) {
            if (error?.code === 'ESRCH') {
              unlinkSync(join(dir, entries[0]))
              try { rmdirSync(dir) } catch (error) {
                if (!isMissing(error) && error?.code !== 'ENOTEMPTY') throw error
              }
            }
          }
        }
      } catch (error) { if (!isMissing(error)) throw error }
      if (Date.now() >= deadline) throw new Error('[multi-codex] timed out waiting for routing lock')
      await sleep(25, undefined, { signal })
    }
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

function readRouting(file) {
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (isMissing(error)) return { leases: [], cooldowns: {} }
    throw new Error(`[multi-codex] cannot read routing state: ${String(error)}`)
  }
  if (!data || !Array.isArray(data.leases) || !data.cooldowns ||
    typeof data.cooldowns !== 'object' || Array.isArray(data.cooldowns) ||
    !Object.values(data.cooldowns).every((until) => typeof until === 'number' && Number.isFinite(until)) ||
    !data.leases.every((lease) => lease && typeof lease.owner === 'string' &&
      typeof lease.conversation === 'string' && typeof lease.account === 'string' &&
      typeof lease.expires === 'number' && Number.isFinite(lease.expires))) {
    throw new Error('[multi-codex] invalid routing state; restore or remove routing file, not auth.json')
  }
  return data
}

function createAccountReservations(file, ownerId) {
  async function update(fn, signal) {
    const release = await routingLock(file, signal)
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      signal?.throwIfAborted()
      const data = readRouting(file)
      const now = Date.now()
      data.leases = data.leases.filter((lease) => lease.expires > now)
      data.cooldowns = Object.fromEntries(Object.entries(data.cooldowns).filter(([, until]) => until > now))
      const result = fn(data, now)
      writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' })
      renameSync(temp, file)
      return result
    } finally {
      try {
        try { unlinkSync(temp) } catch (error) { if (!isMissing(error)) throw error }
      } finally { release() }
    }
  }
  function remove(data, conversation) {
    data.leases = data.leases.filter((lease) => lease.owner !== ownerId ||
      (conversation !== undefined && lease.conversation !== conversation))
  }
  return {
    select(conversation, accounts, tried, preferred, signal) {
      return update((data, now) => {
        const eligible = [...new Set(accounts)].filter((id) => !tried.has(id) && !(data.cooldowns[id] > now))
        const sticky = data.leases.find((lease) => lease.owner === ownerId && lease.conversation === conversation)
        if (sticky && eligible.includes(sticky.account)) {
          sticky.expires = now + LEASE_MS
          return sticky.account
        }
        remove(data, conversation)
        const counts = new Map(eligible.map((id) => [id, data.leases.filter((lease) => lease.account === id).length]))
        const min = Math.min(...counts.values())
        const candidates = eligible.filter((id) => counts.get(id) === min)
        const account = preferred && candidates.includes(preferred) ? preferred : candidates[0]
        if (account) data.leases.push({ owner: ownerId, conversation, account, expires: now + LEASE_MS })
        return account
      }, signal)
    },
    pin(conversation, account) {
      return update((data, now) => {
        remove(data, conversation)
        data.leases.push({ owner: ownerId, conversation, account, expires: now + LEASE_MS })
      })
    },
    cooldown(account, until, signal) {
      return update((data) => { data.cooldowns[account] = Math.max(data.cooldowns[account] ?? 0, until) }, signal)
    },
    renew() {
      return update((data, now) => {
        for (const lease of data.leases) if (lease.owner === ownerId) lease.expires = now + LEASE_MS
      })
    },
    release(conversation) { return update((data) => remove(data, conversation)) },
  }
}

// --- routing core: failover across accounts around pi-ai's codex streams ---

function errorText(event) {
  return event.type === 'error' ? (event.error.errorMessage ?? '') : ''
}

function assistantError(model, message) {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  }
}

function createRoutedStream(inner, deps) {
  return (model, context, options) => {
    const out = createAssistantMessageEventStream()
    const conversation = options?.sessionId ?? deps.fallbackConversation
    let latest
    function forward(event) {
      latest = event.type === 'done' ? event.message : event.type === 'error' ? event.error : event.partial
      out.push(event)
    }
    function checkActive() {
      options?.signal?.throwIfAborted()
    }
    void (async () => {
      try {
        checkActive()
        const tried = new Set()
        // Worded to match retryable-error patterns so the outer retry layer
        // can re-enter the router after cooldowns lapse.
        const exhausted = (cause) => new Error(`[multi-codex] no available codex account: every account is rate-limited, on cooldown, or missing auth${cause ? ` (last: ${cause})` : ''}; run /multi-codex-auth list`)
        async function failover(id, text) {
          checkActive()
          const auth = /401|403|unauthori[sz]ed|invalid.?grant|forbidden/i.test(text)
          await deps.cooldown(id, Date.now() + (auth ? LEASE_MS : 60_000), options?.signal)
          checkActive()
          const next = await deps.select(conversation, tried, options?.signal)
          if (next) deps.notify?.(`[multi-codex] ${label(id)} failed → ${label(next)}, retrying`)
          return next
        }
        let id = await deps.select(conversation, tried, options?.signal)
        while (id) {
          const account = id
          tried.add(account)
          let emitted = false
          try {
            checkActive()
            const token = await deps.accessToken(account, options?.signal).catch(() => undefined)
            checkActive()
            if (!token) {
              id = await failover(account, '401 auth unusable')
              continue
            }
            deps.setCurrent(account, conversation)
            const it = inner.stream(model, context, { ...options, apiKey: token })[Symbol.asyncIterator]()
            const first = await it.next()
            if (first.done) throw new Error('[multi-codex] stream ended without events')
            const event = first.value
            if (event.type === 'done' || (event.type === 'error' && options?.signal?.aborted)) {
              forward(event)
              return
            }
            checkActive()
            if (event.type === 'error' && FAILOVER.test(errorText(event))) {
              const next = await failover(account, errorText(event))
              if (next) { id = next; continue }
              throw exhausted(errorText(event))
            }
            forward(event)
            emitted = true
            let terminal = event.type === 'error'
            for await (const rest of { [Symbol.asyncIterator]: () => it }) {
              forward(rest)
              terminal ||= rest.type === 'done' || rest.type === 'error'
            }
            if (!terminal) throw new Error('[multi-codex] stream ended without terminal event')
            return
          } catch (error) {
            if (!emitted && !options?.signal?.aborted && FAILOVER.test(String(error))) {
              const next = await failover(account, String(error))
              if (next) { id = next; continue }
              throw exhausted(String(error))
            }
            throw error
          }
        }
        throw exhausted()
      } catch (error) {
        const reason = options?.signal?.aborted ? 'aborted' : 'error'
        out.push({ type: 'error', reason, error: {
          ...(latest ?? assistantError(model, String(error))), stopReason: reason, errorMessage: String(error),
        } })
      } finally {
        out.end()
      }
    })()
    return out
  }
}

// --- pi-ai replay state (durable provider-native fidelity) ---

function parseArguments(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
  } catch {}
  return {}
}

function emptyPiUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function toPiReplayState(message, requestedModel = message.model) {
  return {
    response: {
      kind: 'pi-ai',
      version: 2,
      api: message.api,
      provider: message.provider,
      model: requestedModel,
      ...message.responseModel === undefined ? {} : { responseModel: message.responseModel },
      ...message.responseId === undefined ? {} : { responseId: message.responseId },
      ...message.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: message.providerThinkingLevel },
      stopReason: message.stopReason,
    },
    blocks: message.content.map((block) => {
      switch (block.type) {
        case 'text': return {
          type: 'text',
          ...block.textSignature === undefined ? {} : { textSignature: block.textSignature },
        }
        case 'thinking': return {
          type: 'reasoning',
          ...block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature },
          ...block.redacted === undefined ? {} : { redacted: block.redacted },
        }
        case 'toolCall': return {
          type: 'tool-call',
          ...block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature },
          ...block.namespace === undefined ? {} : { namespace: block.namespace },
        }
        default: return { type: 'text' }
      }
    }),
  }
}

function foreignAssistant(message) {
  const source = message.source
  const content = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break
      case 'reasoning': content.push({ type: 'thinking', thinking: block.text }); break
      case 'tool-call': content.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
      }); break
      case 'image':
        throw new Error('[multi-codex] pi-ai chat history cannot represent structured assistant image output')
      default:
        break
    }
  }
  return {
    role: 'assistant',
    content,
    // Deliberately never equals a catalog API: absent replay state is foreign
    // even if source names the same provider/model as this request.
    api: 'dsh-foreign',
    provider: source.provider,
    model: source.model,
    usage: emptyPiUsage(),
    stopReason: content.some((piece) => piece.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

function readReplayState(value) {
  const bad = (m) => { throw new Error(`invalid pi-ai replay state: ${m}`) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad('expected a replay envelope')
  const response = value.response
  if (typeof response !== 'object' || response === null || Array.isArray(response)) bad('expected a response object')
  if (response.kind !== 'pi-ai') bad('unknown state kind')
  if (response.version !== 2) bad(`unsupported version ${String(response.version)}`)
  for (const key of ['api', 'provider', 'model']) {
    if (typeof response[key] !== 'string' || response[key].length === 0) bad(`${key} must be a non-empty string`)
  }
  if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(response.stopReason))) bad('unknown stopReason')
  const blocks = value.blocks
  if (!Array.isArray(blocks)) bad('blocks must be an array')
  return { response, blocks }
}

function replayedAssistant(message, source, rawState) {
  const state = readReplayState(rawState)
  const bad = (m) => { throw new Error(`invalid pi-ai replay state: ${m}`) }
  if (state.response.provider !== source.provider) bad('provider does not match assistant source')
  if (state.response.model !== source.model) bad('model does not match assistant source')
  if (state.blocks.length !== message.content.length) bad('block count does not match assistant content')
  const content = message.content.map((block, index) => {
    const replay = state.blocks[index]
    if (replay === undefined || replay.type !== block.type) bad(`block ${index} does not match assistant content`)
    switch (block.type) {
      case 'text': return {
        type: 'text',
        text: block.text,
        ...replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {},
      }
      case 'reasoning': return {
        type: 'thinking',
        thinking: block.text,
        ...replay.thinkingSignature !== undefined ? { thinkingSignature: replay.thinkingSignature } : {},
        ...replay.redacted !== undefined ? { redacted: replay.redacted } : {},
      }
      case 'tool-call': return {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
        ...replay.thoughtSignature !== undefined ? { thoughtSignature: replay.thoughtSignature } : {},
        ...replay.namespace !== undefined ? { namespace: replay.namespace } : {},
      }
      default: bad(`block ${index} has an unsupported type`)
    }
  })
  return {
    role: 'assistant',
    content,
    api: state.response.api,
    provider: state.response.provider,
    model: state.response.model,
    ...state.response.responseModel === undefined ? {} : { responseModel: state.response.responseModel },
    ...state.response.responseId === undefined ? {} : { responseId: state.response.responseId },
    ...state.response.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: state.response.providerThinkingLevel },
    usage: emptyPiUsage(),
    stopReason: state.response.stopReason,
    timestamp: 0,
  }
}

function toPiAssistant(message) {
  const source = message.source
  if (source.replayState === undefined) return foreignAssistant(message)
  try {
    return replayedAssistant(message, source, source.replayState)
  } catch {
    // Unusable replay state degrades this one message to provider-neutral
    // history instead of failing the request.
    return foreignAssistant(message)
  }
}

// --- harness request history -> pi-ai TranscriptContext ---

const IMAGE_PIXEL_BUDGET = 4_194_304

function flattenText(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function contentHasImage(content) {
  return content.some((block) => block.type === 'image')
}

function assertSupportedHistory(messages) {
  for (const message of messages) {
    if (message.role !== 'developer' && message.content.some((block) => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      throw new Error('[multi-codex] tool-change blocks require developer role')
    }
    if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
      throw new Error(`[multi-codex] pi-ai cannot represent an image in an in-history ${message.role} message`)
    }
    if (message.role === 'system' && message.content.some((block) => block.type !== 'text')) {
      throw new Error('[multi-codex] pi-ai cannot represent non-text system messages')
    }
  }
}

function splitSystemPrompt(options) {
  const text = [options.system]
  let end = 0
  for (const message of options.messages) {
    if (message.role !== 'system') break
    text.push(flattenText(message))
    end++
  }
  const systemPrompt = text.filter(Boolean).join('\n\n')
  return { systemPrompt: systemPrompt || undefined, messages: options.messages.slice(end) }
}

function piTool(tool) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

function toolsOf(options) {
  return options.tools?.filter((tool) => !tool.deferLoading).map(piTool)
}

function piContext(systemPrompt, options, messages) {
  const tools = toolsOf(options)
  return {
    ...systemPrompt !== undefined ? { systemPrompt } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

function appendDeveloper(message, options, messages) {
  const content = []
  const toolsAdded = []
  const toolsRemoved = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'tool-addition': {
        const tool = options.tools?.find((t) => t.name === block.toolName)
        if (tool === undefined) throw new Error(`[multi-codex] tool update references undeclared tool "${block.toolName}"`)
        toolsAdded.push(piTool(tool))
        break
      }
      case 'tool-removal':
        toolsRemoved.push({ name: block.toolName })
        break
      default:
        throw new Error(`[multi-codex] pi-ai cannot represent developer content ${block.type}`)
    }
  }
  if (content.length === 0 && toolsAdded.length === 0 && toolsRemoved.length === 0) return
  messages.push({
    role: 'system',
    content,
    timestamp: 0,
    ...toolsAdded.length === 0 ? {} : { toolsAdded },
    ...toolsRemoved.length === 0 ? {} : { toolsRemoved },
  })
}

function toolResultOf(message, toolNames, content) {
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: toolNames.get(message.toolCallId) ?? 'unknown',
    content: typeof content === 'string'
      ? [{ type: 'text', text: content || '(no output)' }]
      : content,
    isError: message.isError ?? false,
    timestamp: 0,
  }
}

function requestImageTargetFor(ref) {
  const pixels = ref.width * ref.height
  if (pixels <= IMAGE_PIXEL_BUDGET) return { width: ref.width, height: ref.height, maxBytes: ref.bytes }
  const scale = Math.sqrt(IMAGE_PIXEL_BUDGET / pixels)
  return {
    width: Math.max(1, Math.floor(ref.width * scale)),
    height: Math.max(1, Math.floor(ref.height * scale)),
    maxBytes: ref.bytes,
  }
}

function imageHandleText(attachment, version) {
  return `[image attachment ${attachment.attachmentId} — ${version.width ?? attachment.width}x${version.height ?? attachment.height}]`
}

async function prepareRequestImages(messages, attachments, signal) {
  const refs = new Map()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
  const ordered = [...refs.values()]
  const prepared = await Promise.all(ordered.map(
    (ref) => attachments.readImageRequest(ref, requestImageTargetFor(ref), signal),
  ))
  const versions = new Map()
  for (const [index, ref] of ordered.entries()) versions.set(ref.attachmentId, prepared[index])
  return versions
}

function userContent(blocks, requestImages) {
  const content = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        if (block.offloaded === true) {
          content.push({ type: 'text', text: `[image attachment ${block.attachment.attachmentId} omitted from this request]` })
          break
        }
        const version = requestImages.get(block.attachment.attachmentId)
        content.push({ type: 'text', text: imageHandleText(block.attachment, version) })
        content.push({
          type: 'image',
          data: Buffer.from(version.data).toString('base64'),
          mimeType: version.mediaType,
        })
        break
      }
      default:
        break
    }
  }
  if (content.every((block) => block.type === 'text')) return content.map((block) => block.text).join('')
  return content
}

async function toPiContext(options, attachments) {
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const withImages = split.messages.some((message) => contentHasImage(message.content))
  if (withImages && attachments === undefined) {
    throw new Error('[multi-codex] image input requires the durable attachment service')
  }
  const requestImages = withImages
    ? await prepareRequestImages(split.messages, attachments, options.signal)
    : new Map()
  const toolNames = new Map()
  const messages = []
  for (const message of split.messages) {
    if (message.role === 'developer') {
      appendDeveloper(message, options, messages)
      continue
    }
    if (message.role === 'system') {
      const content = flattenText(message)
      if (content.length > 0) messages.push({ role: 'system', content, timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }
    if (message.role === 'tool') {
      messages.push(toolResultOf(
        message,
        toolNames,
        withImages ? userContent(message.content, requestImages) : flattenText(message),
      ))
      continue
    }
    const content = withImages ? userContent(message.content, requestImages) : flattenText(message)
    messages.push({ role: 'user', content, timestamp: 0 })
  }
  return piContext(split.systemPrompt, options, messages)
}

// --- pi-ai event stream -> harness StreamChunks ---

function isContextWindowExceededError(detail) {
  return /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || /context\s*(?:length|window)\s*exceeded/i.test(detail)
}

function isQuotaExceededError(detail) {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
}

function classifyPiAiError(message) {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b413\b|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

function mapUsage(usage) {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

function mapStopReason(message, contextWindow) {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }
  switch (message.stopReason) {
    case 'stop':
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
    default:
      return { kind: 'error', failure: { message: `pi-ai stream for model "${message.model}" ended ${String(message.stopReason)}`, code: 'PI_AI_ERROR' } }
  }
}

async function* toStreamChunks(events, contextWindow, callerSignal, requestedModel) {
  const toolIds = new Map()
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: known?.id ?? '',
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: event.toolCall.id,
            name: event.toolCall.name,
            // pi-ai hands back the PARSED arguments; the harness vocabulary
            // keeps the raw string.
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message, contextWindow),
          replayState: toPiReplayState(event.message, requestedModel),
        }
        return
      case 'error':
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(
            callerSignal?.aborted ? { ...event.error, stopReason: 'aborted' } : event.error,
            contextWindow,
          ),
        }
        return
      default:
        break
    }
  }
  throw new Error('[multi-codex] pi-ai event stream ended without done/error')
}

// --- model metadata ---

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function supportedThinkingLevels(model) {
  if (!model.reasoning) return ['off']
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

function resolveReasoningLevel(model, effort) {
  if (effort === undefined) return undefined
  const supported = supportedThinkingLevels(model)
  if (supported.some((level) => level === effort)) return effort
  throw new Error(`[multi-codex] model "${model.id}" does not support reasoning effort "${effort}"`)
}

function conversationUpdates(model) {
  const compat = model.compat
  if (compat === undefined || !('supportsMidConvoSystemMessages' in compat)
    || !compat.supportsMidConvoSystemMessages) return {}
  const updates = { systemPromptUpdate: 'in-history' }
  if ((model.api === 'openai-responses' || model.api === 'azure-openai-responses' || model.api === 'openai-codex-responses')
    && (('supportsAdditionalTools' in compat && compat.supportsAdditionalTools)
      || ('supportsToolSearch' in compat && compat.supportsToolSearch))) {
    updates.toolUpdate = 'addition-only'
  }
  return updates
}

// --- Codex image tool ---

const IMAGE_TIMEOUT_MS = 300_000
const IMAGE_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const SAFE_IMAGE_ERROR_CODES = new Set([
  'account_deactivated', 'billing_hard_limit_reached', 'content_policy_violation',
  'insufficient_quota', 'invalid_api_key', 'invalid_image', 'invalid_request_error',
  'model_not_found', 'rate_limit_exceeded', 'server_error', 'usage_limit_reached',
  'usage_not_included',
])

function accountIdFromToken(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error()
    const claim = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))?.[
      'https://api.openai.com/auth'
    ]?.chatgpt_account_id
    if (typeof claim !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(claim)) throw new Error()
    return claim
  } catch {
    throw new Error('unable to read Codex account ID from OAuth token')
  }
}

function inlineImageReference(path, cwd) {
  const absolutePath = resolve(cwd, path)
  const mime = ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp',
  })[extname(path).toLowerCase()]
  if (!mime) throw new Error('unsupported image MIME type for reference image')
  const bytes = readFileSync(absolutePath)
  const valid = mime === 'image/png'
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg'
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mime === 'image/gif'
        ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!valid) throw new Error('reference image bytes do not match supported MIME type')
  return { image_url: `data:${mime};base64,${bytes.toString('base64')}` }
}

function decodePng(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Codex returned an invalid image response')
  }
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.toString('base64') !== value ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Codex returned an invalid image response')
  }
  return bytes
}

function safeImageErrorCode(payload) {
  const code = payload?.error?.code ?? payload?.error?.type
  return typeof code === 'string' && SAFE_IMAGE_ERROR_CODES.has(code) ? code : undefined
}

function imageHttpError(status, payload) {
  const code = safeImageErrorCode(payload)
  return new Error(`Codex image request failed (HTTP ${status}${code ? `: ${code}` : ''})`)
}

// --- plugin wiring ---

export function apply(ctx) {
  const base = builtinProviders().find((p) => p.id === BASE_ID)
  if (!base) throw new Error('built-in openai-codex provider not found')
  if (!base.auth.oauth) throw new Error('built-in openai-codex provider has no oauth')
  const oauth = base.auth.oauth

  const owner = randomUUID()
  const reservations = createAccountReservations(join(AGENT_DIR, 'multi-codex-routing.json'), owner)
  const currentByConversation = new Map()
  let lastCurrent

  const deps = {
    fallbackConversation: owner,
    async select(chat, tried, signal) {
      return reservations.select(chat, codexAccountsWithAuth(), tried, loadState().current, signal)
    },
    cooldown: (id, until, signal) => reservations.cooldown(id, until, signal),
    setCurrent(id, chat) {
      currentByConversation.set(chat, id)
      lastCurrent = id
    },
    // Locked read-modify-write: a process that finds the token already
    // refreshed by another process reuses it instead of double-refreshing
    // (OpenAI rotates refresh tokens — a second refresh would fail).
    async accessToken(id, signal) {
      return withAuthLock(async (data) => {
        const cred = data[id]
        if (cred?.type !== 'oauth' || !cred.access) return [undefined]
        if (Date.now() < (cred.expires ?? 0)) return [cred.access]
        const fresh = await oauth.refresh(
          cred,
          signal ?? new AbortController().signal,
        )
        data[id] = { ...fresh, type: 'oauth' }
        return [fresh.access, data]
      }).catch(() => undefined)
    },
    notify: (message) => console.info(message),
  }

  const inner = openAICodexResponsesApi()
  const routedStream = createRoutedStream(inner, deps)
  const models = base.getModels().map((m) => ({ ...m, provider: PROVIDER_ID }))
  const modelsById = new Map(models.map((m) => [m.id, m]))

  function modelOf(provider, modelId) {
    if (provider !== PROVIDER_ID) {
      throw new Error(`[multi-codex] adapter does not own provider "${provider}"`)
    }
    const model = modelsById.get(modelId)
    if (model === undefined) {
      throw new Error(`[multi-codex] unknown model "${modelId}"; available: ${models.map((m) => m.id).join(', ')}`)
    }
    return model
  }

  function modelInfo(provider, modelId) {
    const model = modelOf(provider, modelId)
    const levels = model.reasoning ? supportedThinkingLevels(model) : []
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
      context: { contextWindow: model.contextWindow },
      ...levels.length === 0 ? {} : {
        reasoning: {
          efforts: levels.map((level) => ({
            id: level,
            name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
          })),
        },
      },
      ...conversationUpdates(model),
    }
  }

  const attachmentsOf = () => ctx.get('attachments')
  const workingDirectoryOf = () => ctx.get('workingDirectory')

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: 'OpenAI Codex (multi)' }
    },
    providerRetryPolicy() {
      // The router owns visible account failover; leave the executor's normal
      // defaults for whole-request retries.
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    imageRequestTarget(_provider, _model, image) {
      return requestImageTargetFor(image)
    },
    async listModels(provider) {
      modelOf(provider, models[0]?.id ?? '')
      if (codexAccountsWithAuth().length === 0) return []
      return models.map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    },
    async resolveModel(provider, modelId) {
      return modelInfo(provider, modelId)
    },
    async prepareCall(provider, modelId) {
      const info = modelInfo(provider, modelId)
      return { model: info, stream: (options) => adapter.stream(options) }
    },
    async *stream(options) {
      if (options.stop !== undefined) {
        throw new Error('[multi-codex] GenerateOptions.stop is not supported')
      }
      const model = modelOf(options.provider, options.model)
      if (contentHasImageInMessages(options.messages) && !model.input.includes('image')) {
        throw new Error(`[multi-codex] model "${model.id}" does not support image input`)
      }
      const reasoning = resolveReasoningLevel(model, options.reasoningEffort)
      // Provider APIs read a TranscriptContext: systemPrompt and tools only
      // reach the wire after normalizeContext folds them into the leading
      // system message (the pi-ai Models collection does this on the
      // streamSimple path; calling the API directly must do it explicitly).
      const context = normalizeContext(await toPiContext(options, attachmentsOf()))
      const events = routedStream(model, context, {
        ...reasoning === undefined || reasoning === 'off' ? {} : { reasoning },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: options.signal,
        // The router and the harness recovery layer own visible attempts; one
        // pi-ai call is one attempt.
        maxRetries: 0,
      })
      yield* toStreamChunks(events, model.contextWindow, options.signal, model.id)
    },
  }

  function contentHasImageInMessages(messages) {
    return messages.some((message) => contentHasImage(message.content))
  }

  // --- /multi-codex-auth ---

  const pendingLogins = new Map()

  async function useAccount(id, conversation) {
    await reservations.pin(conversation, id)
    const state = loadState()
    if (state.current !== id) {
      state.current = id
      saveState(state)
    }
    deps.setCurrent(id, conversation)
  }

  function openBrowser(url) {
    if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') return
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true })
      child.on('error', () => {})
      child.unref()
    } catch {}
  }

  function startLogin(lbl, method, conversation) {
    const id = accountId(lbl)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('[multi-codex] login timed out')), 10 * 60_000)
    const entry = { detail: 'starting…', controller }
    pendingLogins.set(lbl, entry)
    const interaction = {
      signal: controller.signal,
      async prompt(p) {
        if (p.type === 'select') {
          const wanted = method === 'device' ? /device/i : /browser/i
          const picked = p.options.find((o) => wanted.test(o.id) || wanted.test(o.label))
          if (!picked) throw new Error('[multi-codex] login method not offered')
          return picked.id
        }
        // Manual code paste cannot reach a backgrounded login; park until the
        // browser callback or the abort wins the race.
        return new Promise((_, reject) => {
          const signal = p.signal ?? controller.signal
          if (signal.aborted) { reject(new Error('[multi-codex] login cancelled')); return }
          signal.addEventListener('abort', () => reject(new Error('[multi-codex] manual code entry skipped')), { once: true })
        })
      },
      notify(e) {
        if (e.type === 'auth_url') {
          entry.detail = `open this URL to finish login:\n${e.url}`
          openBrowser(e.url)
        } else if (e.type === 'device_code') {
          entry.detail = `go to ${e.verificationUri} and enter code: ${e.userCode}`
        } else if (e.type === 'info' || e.type === 'progress') {
          entry.detail = e.message
        }
      },
    }
    entry.promise = (async () => {
      try {
        const credential = await oauth.login(interaction)
        await persistCredential(id, credential)
        const state = loadState()
        if (!state.accounts.includes(lbl)) {
          state.accounts.push(lbl)
          saveState(state)
        }
        await useAccount(id, conversation)
        entry.detail = `logged in as ${lbl}; routing via ${PROVIDER_ID}`
      } catch (error) {
        entry.detail = `login failed: ${error instanceof Error ? error.message : String(error)}`
      } finally {
        clearTimeout(timeout)
        entry.controller = undefined
      }
    })()
    entry.promise.catch(() => {})
    return entry
  }

  const command = {
    name: 'multi-codex-auth',
    description: 'Manage multi-Codex accounts (shared with pi): login <label> [device] | use <label|default> | list | cancel <label>',
    input: { hint: 'login <label> [device] | use <label|default> | list | cancel <label>' },
    async handler(invocation) {
      const [sub, ...rest] = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      const conversation = String(invocation.agent.id)

      if (sub === 'list') {
        const auth = readAuth()
        const ids = [BASE_ID, ...loadState().accounts.map(accountId)]
        let routing
        try { routing = readRouting(join(AGENT_DIR, 'multi-codex-routing.json')) } catch { routing = { leases: [], cooldowns: {} } }
        const now = Date.now()
        const lines = ids.map((id) => {
          const cred = auth[id]
          const status = cred?.type === 'oauth'
            ? Date.now() < (cred.expires ?? 0) ? 'authenticated' : 'authenticated (token refresh due)'
            : 'NOT authenticated'
          const cur = (currentByConversation.get(conversation) ?? lastCurrent) === id ? ' (current)' : ''
          const cooling = routing.cooldowns[id] > now ? `, cooldown ${Math.ceil((routing.cooldowns[id] - now) / 1000)}s` : ''
          const leases = routing.leases.filter((l) => l.account === id && l.expires > now).length
          return `${label(id)} [${id}] — ${status}${cur}${cooling}, ${leases} active lease(s)`
        })
        for (const [lbl, entry] of pendingLogins) {
          if (entry.controller) lines.push(`${lbl} — login pending: ${entry.detail}`)
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      if (sub === 'use') {
        const arg = rest[0]
        if (!arg) return { kind: 'error', text: 'usage: /multi-codex-auth use <label|default>' }
        const id = arg === 'default' ? BASE_ID : accountId(arg)
        if (readAuth()[id]?.type !== 'oauth') {
          return { kind: 'error', text: `[multi-codex] ${id} is not authenticated` }
        }
        await useAccount(id, conversation)
        return { kind: 'success', text: `[multi-codex] using ${label(id)}` }
      }

      if (sub === 'cancel') {
        const arg = rest[0]
        const entry = arg && pendingLogins.get(arg)
        if (!entry?.controller) return { kind: 'error', text: `[multi-codex] no pending login for "${arg ?? ''}"` }
        entry.controller.abort(new Error('[multi-codex] login cancelled'))
        pendingLogins.delete(arg)
        return { kind: 'success', text: `[multi-codex] cancelled login for ${arg}` }
      }

      if (sub !== 'login') {
        return { kind: 'error', text: 'usage: /multi-codex-auth login <label> [device] | use <label|default> | list | cancel <label>' }
      }

      const lbl = rest[0]?.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
      if (!lbl) return { kind: 'error', text: 'usage: /multi-codex-auth login <label> [device] — label is required (e.g. work, personal)' }
      const method = rest[1] === 'device' ? 'device' : 'browser'
      const existing = pendingLogins.get(lbl)
      if (existing?.controller) {
        return { kind: 'success', text: `[multi-codex] login for ${lbl} already pending: ${existing.detail}` }
      }
      const entry = startLogin(lbl, method, conversation)
      // Give the flow a moment to publish its first instruction (auth URL or
      // device code) so the result carries it even if the browser did not open.
      const deadline = Date.now() + 5_000
      while (entry.detail === 'starting…' && Date.now() < deadline && entry.controller) {
        await new Promise((r) => setTimeout(r, 100))
      }
      return {
        kind: 'success',
        text: `[multi-codex] login started for ${lbl} — ${entry.detail}\nIt completes in the background; check /multi-codex-auth list. If the browser cannot reach the callback (port 1455 busy), log in from pi instead: /multi-codex-auth login ${lbl}`,
      }
    },
  }

  // --- multi_codex_image tool ---

  const imageTool = {
    name: 'multi_codex_image',
    description: 'Generate an image or edit reference images with the active multi-Codex OAuth accounts. Saves a new PNG without overwriting existing files.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Image generation or edit prompt' },
        output: { type: 'string', description: 'PNG output path, relative to the current working directory' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Optional PNG, JPEG, GIF, or WebP paths to edit' },
        size: { type: 'string', pattern: '^(auto|[1-9][0-9]{0,4}x[1-9][0-9]{0,4})$', description: 'auto or WIDTHxHEIGHT' },
        quality: { enum: ['auto', 'low', 'medium', 'high'] },
        background: { enum: ['auto', 'opaque', 'transparent'] },
      },
      required: ['prompt', 'output'],
      additionalProperties: false,
    },
    timeoutMs: IMAGE_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          account: { type: 'string' },
        },
        required: ['path', 'account'],
      },
      render(_args, value) {
        const content = [{ type: 'text', text: `${value.path} (account: ${value.account})` }]
        if (value.image) content.push({ type: 'image', attachment: value.image })
        return content
      },
    },
    async execute(params, exec) {
      const timeout = AbortSignal.timeout(IMAGE_TIMEOUT_MS)
      const requestSignal = exec.signal ? AbortSignal.any([exec.signal, timeout]) : timeout
      const checkActive = () => {
        if (requestSignal.aborted) {
          throw new Error(requestSignal.reason?.name === 'TimeoutError' ? 'Codex image request timed out' : 'Codex image request aborted')
        }
      }
      checkActive()
      if (!params.prompt.trim()) throw new Error('prompt must not be empty')
      if (extname(params.output).toLowerCase() !== '.png') throw new Error('output path must end in .png')
      if ((params.reference_images?.length ?? 0) > 5) throw new Error('at most 5 reference images are supported')
      const size = params.size ?? 'auto'
      const quality = params.quality ?? 'auto'
      const background = params.background ?? 'auto'
      if (!/^(auto|[1-9][0-9]{0,4}x[1-9][0-9]{0,4})$/.test(size) ||
        !['auto', 'low', 'medium', 'high'].includes(quality) ||
        !['auto', 'opaque', 'transparent'].includes(background)) {
        throw new Error('invalid Codex image options')
      }
      const workingDirectory = workingDirectoryOf()
      const cwd = exec.agent === undefined || workingDirectory === undefined
        ? process.cwd()
        : await workingDirectory.ensure(exec.agent, requestSignal)
      const outputPath = resolve(cwd, params.output)
      mkdirSync(dirname(outputPath), { recursive: true })
      try {
        lstatSync(outputPath)
        throw new Error('output file already exists')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const images = (params.reference_images ?? []).map((path) => inlineImageReference(path, cwd))
      const body = {
        ...(images.length ? { images } : {}),
        prompt: params.prompt,
        model: 'gpt-image-2',
        n: 1,
        background,
        quality,
        size,
      }
      const conversation = exec.agent === undefined ? deps.fallbackConversation : String(exec.agent.id)
      const tried = new Set()
      let account = await deps.select(conversation, tried, requestSignal)
      checkActive()
      if (!account) throw new Error('no available Codex OAuth account for image request')
      let response
      for (;;) {
        tried.add(account)
        const token = await deps.accessToken(account, requestSignal)
        checkActive()
        if (!token) {
          await deps.cooldown(account, Date.now() + LEASE_MS, requestSignal)
          checkActive()
          const next = await deps.select(conversation, tried, requestSignal)
          checkActive()
          if (!next) throw new Error('no available Codex OAuth account for image request')
          account = next
          continue
        }
        const chatgptAccountId = accountIdFromToken(token)
        deps.setCurrent(account, conversation)
        try {
          response = await fetch(`${IMAGE_BASE_URL}/images/${images.length ? 'edits' : 'generations'}`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'ChatGPT-Account-Id': chatgptAccountId,
              originator: 'codex_cli_rs',
              'x-codex-image-turn-id': randomUUID(),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: requestSignal,
          })
        } catch {
          checkActive()
          throw new Error('Codex image request failed due to network error')
        }
        checkActive()
        let payload
        try { payload = await response.json() } catch { payload = undefined }
        checkActive()
        if ([401, 403, 429].includes(response.status)) {
          await deps.cooldown(account, Date.now() + (response.status === 429 ? 60_000 : LEASE_MS), requestSignal)
          checkActive()
          const next = await deps.select(conversation, tried, requestSignal)
          checkActive()
          if (!next) throw imageHttpError(response.status, payload)
          account = next
          continue
        }
        if (!response.ok) throw imageHttpError(response.status, payload)
        const image = decodePng(payload?.data?.[0]?.b64_json)
        checkActive()
        try {
          writeFileSync(outputPath, image, { flag: 'wx', mode: 0o600 })
        } catch (error) {
          if (error?.code === 'EEXIST') throw new Error('output file already exists')
          throw error
        }
        const attachments = attachmentsOf()
        const ref = attachments === undefined ? undefined : await attachments.saveImage({
          data: new Uint8Array(image),
          mediaType: 'image/png',
          name: params.output,
        })
        return {
          path: outputPath,
          account: label(account),
          ...ref === undefined ? {} : { image: ref },
        }
      }
    },
  }

  return ctx.effect(() => {
    const disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
    const disposeTool = ctx.tools.register(imageTool)
    const disposeCommand = ctx.commands.register(command)
    // Keep this process's leases fresh while any conversation is active.
    const renewal = setInterval(() => {
      reservations.renew().catch(() => {})
    }, 60_000)
    renewal.unref?.()
    return async () => {
      clearInterval(renewal)
      disposeAdapter()
      disposeTool()
      disposeCommand()
      for (const entry of pendingLogins.values()) entry.controller?.abort(new Error('[multi-codex] plugin unloaded'))
      await reservations.release().catch(() => {})
    }
  })
}
