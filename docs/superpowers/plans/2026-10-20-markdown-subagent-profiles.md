# Markdown Subagent Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

English | [中文](2026-10-20-markdown-subagent-profiles.zh.md)

**Goal:** Add native Harness delegation from compatible Markdown agent definitions, including ordered cross-provider fallback without replacing the child Session.

**Architecture:** One opt-in Host plugin, `@deepseek-ai/dsh-tool-subagent-profiles`, supplies profile discovery, child setup, routing, and the model-facing tool. Extend the existing subagent manager with registered, restorable child setup and the tool registry with an opt-in whole-scope restriction. Keep the agent loop, default bundles, and existing delegation behavior unchanged.

**Tech Stack:** TypeScript ESM, Cordis, existing `js-yaml` and Zod, native subagent activations, Session projections, Vitest, and shipped-profile snapshot replay; no Pi/Paseo dependency.

**Spec:** [Approved proposal](../../../.agents/notes/implemented/feature/2026-10-20-markdown-subagent-profiles.md). Implementation steps and local verification have been executed; the package README documents supported behavior, with existing documentation failures recorded separately.

## Global Constraints

- Runtime is Harness-only; use supported `dsh` profiles, not a new executable or SDK argv override.
- Use `$DSH_HOME/agents/*.md` and the original project's `.dsh/agents/*.md`; project discovery requires operator opt-in, and Pi paths are never searched implicitly.
- Single and parallel runs return native child ids; chains await results; resume is single-mode only and authorized by the native continuation manager.
- Advance multi-model chains only on provider-policy-admitted retries; exhaustion is terminal, single-model profiles retain ordinary retries, and completed tools are never replayed deliberately.
- Preserve persona, tool restrictions, and selected route through persisted child records; configured provider credentials and compatible tool names remain prerequisites.
- All registrations are owned effects. Validate file/tool/persistence inputs, add no `as unknown`, update affected bilingual docs and persistence declarations, and preserve committed Session generations.
- Do not enable the plugin in default bundles, add new UI/artwork, import Pi settings, or implement chain crash recovery.

## Review Focus

- Malformed `tools` values and an explicit empty list must never widen child permissions; test in Tasks 2 and 3.
- A route like `gateway/vendor/model:high` must preserve the inner slash, clear previous-route effort where appropriate, and reject unsupported effort; test in Tasks 3 and 4.
- Two overlapping delegations must not exchange profiles, tool lists, route state, or cleanup ownership; test in Tasks 1 and 5.
- Changed/deleted Markdown and a missing setup plugin must not silently alter a cold-resumed child; test in Tasks 1 and 4.
- Cancellation during retry delay, parallel startup, or chain completion must start no unintended next work and release exactly the owned children; test in Tasks 4 and 5.

---

## File ownership

`packages/subagent/tool-subagent-profiles/src/` contains `index.ts` (Config and owned registrations), `profiles.ts` (Markdown parsing/discovery), `types.ts` (profile and request/result types), `state.ts` (persisted profile and route projections), `runtime.ts` (child persona, restrictions, and routing), and `delegate.ts` (single/parallel/chain/resume). Tests and real Loader fixtures live in that package's `tests/`. Do not add a second agent factory, provider SDK, or general workflow engine.

Existing native changes stay in `packages/subagent/subagent/src/{types,index,descriptor,manager}.ts` and `packages/core/tools/src/index.ts`, with tests and owning README/subsystem pairs. Packaging touches the new package manifest/tsconfig, `tsconfig.host.json`, generated source-path mapping, `scripts/product-package-policy.ts`, and `pnpm-lock.yaml`. Session snapshots live under `snapshots/session/` and SDK projection expectations remain owner-local.

### Task 1: Restorable native child setup

**Files:** Modify `packages/subagent/subagent/src/{types,index,descriptor,manager}.ts`; add `packages/subagent/subagent/tests/child-setup.spec.ts`; update the subagent README and `docs/subsystems/subagent.md` pairs.

**Interfaces:** Export `SubagentChildSetup` with `key: string` and `data: JsonValue`; add optional `childSetup` to `SubagentActivationSpec`, not provider requests. Export a handler taking `(childCtx: Context, child: Agent, input: { kind: 'startup'; data: JsonValue } | { kind: 'resume' })` and returning `void | Promise<void>`. Add `ctx.subagents.registerChildSetup(key, handler): () => void`; duplicate/missing registrations fail loudly. Use `JsonValue` from `dsh-util-values` and existing branded Session ids.

- [x] **Step 1: Write failing tests** for distinct setup data under two concurrent starts, setup before publication/first request, setup rejection rollback, external-backend rejection before dispatch, duplicate registration, disposal, cold restore, and missing-handler refusal. Assert the existing unextended descriptor remains version `3`; a setup-backed descriptor uses version `4` with only a `childSetup` key, and version `3` remains readable unchanged.
- [x] **Step 2: Run the red test:** `pnpm exec vitest run packages/subagent/subagent/tests/child-setup.spec.ts`. Expect missing API/type failures before implementation, not missing dependencies.
- [x] **Step 3: Implement** an instance-owned effect-backed setup registry. Snapshot startup JSON before the first await. Resolve the handler before materialization, append its required key in the setup-backed descriptor, and invoke it inside the existing unpublished factory setup after preset/policy setup. Cold resume resolves the persisted key and invokes the same handler without startup data before publishing the child. The handler owns persistence of its feature data; do not duplicate its snapshot inside the descriptor. Preserve version-3 key validation and add explicit version-4 validation, never reinterpret unknown versions as version 3. Keep provider APIs and the agent loop unchanged.
- [x] **Step 4: Verify green/regressions:** run the new spec plus `activation-policy.spec.ts`, `continuation.spec.ts`, `continuation-presets.spec.ts`, `external-activation.spec.ts`, and `catalog.spec.ts` in `packages/subagent/subagent/tests/`. Assert failed setup publishes no usable child and consumes no capacity.
- [x] **Step 5: Record the persistence change** with the repository recording command and reviewed bilingual prose, covering descriptor version-4 refusal by older readers and continued version-3 support. Run its focused checks. Create an upgrade guide only if implementation introduces an externally perceptible break; do not break existing children merely to support profile children.
- [x] **Step 6: Checkpoint:** review the focused diff and commit only these files and their required documentation/history if committing is authorized; otherwise retain the task as an uncommitted checkpoint.

### Task 2: Enforce profile restrictions on the entire child scope

**Files:** Modify `packages/core/tools/src/index.ts`, `packages/core/tools/tests/scoped.spec.ts`, `packages/core/tools/tests/ptc.spec.ts`, the tools README pair, and `docs/subsystems/tools.md` pair.

**Interfaces:** Extend `ToolRuntime.restrict(filter: ToolRestriction, options?: { readonly includeScoped?: boolean }): () => void`. Absence of `includeScoped` preserves the current inherited-tool restriction. With `true`, the allow/deny restriction also covers the child's own scoped end-capability registrations. Do not add a persisted property to `ToolRestriction` or change historical descriptor filters.

- [x] **Step 1: Write failing tests** asserting that `includeScoped: true` masks and rejects a same-scope denied tool through schema/get lookup, native execution, and PTC nested dispatch, including a tool registered after the restriction. Assert empty `allow: []` denies all end-capability tools, allowed local names validate, restrictions intersect across ancestor scopes, parent/sibling scopes remain unchanged, and disposal restores visibility. Pin legacy own-scope exemption without the option. Keep reserved `run_code` transport outside capability filtering while denying its nested disallowed calls.
- [x] **Step 2: Run red:** `pnpm exec vitest run packages/core/tools/tests/scoped.spec.ts packages/core/tools/tests/ptc.spec.ts`.
- [x] **Step 3: Implement** the option in the existing restriction entries and unified registry view, applying whole-scope filters after scoped shadowing and before presentation transport insertion. Validate names against the appropriate complete capability set, and use the same filtered view at execution. Use an existing monotonic guard only if an actual alternative execution path bypasses that view; do not add redundant enforcement layers.
- [x] **Step 4: Run green** for both files plus `packages/core/tools/tests/tools.spec.ts` and `packages/core/tools/tests/ptc-calls.spec.ts`. Confirm disposal and alternate-dispatch denial with assertions, not prompt wording.
- [x] **Step 5: Checkpoint** the opt-in behavior and owning docs without changing default restriction semantics.

### Task 3: Add the optional package and Markdown discovery

**Files:** Create the new package's `package.json`, `tsconfig.json`, `src/{index,types,profiles}.ts`, `tests/profiles.spec.ts`, `tests/fixtures/loader/cordis.yml`, README pair, and locale files. Register it in `tsconfig.host.json` and `scripts/product-package-policy.ts` as `optional`; regenerate source paths and update `pnpm-lock.yaml`.

**Interfaces:** `parseProfile(text: string, filePath: string, source: 'user' | 'project'): ParsedProfile`; `discoverProfiles(spec: ProfileDiscoverySpec, signal: AbortSignal): Promise<ProfileCatalog>`. `ParsedProfile` carries `name`, `description`, `persona`, optional `tools`, and optional ordered routes; `ProfileCatalog` carries definitions and diagnostics. `ProfileRoute` contains provider/model and optional branded reasoning effort. Discovery specs contain resolved operator-owned directory paths and project opt-in, never model-selected filesystem paths.

**Config decisions:** `toolName` defaults to `subagent_profiles`; `provider` defaults to `spawn`; `userDirectory` optionally replaces `dshHomePath('agents')`; `includeProjectAgents` defaults to `false`; optional `agentPreset` chooses the child base composition; optional numeric `maxDepth` otherwise uses `subagents.resolveMaxDepth()`. Mount one instance on the Host, and require a local fresh-child provider. Resolve configuration defaults explicitly before execution. Use installed `js-yaml` as a declared runtime dependency, not Pi's frontmatter parser.

- [x] **Step 1: Write failing parser/discovery tests** for the user's four-field format and current auxiliary metadata, string/array/empty tools, body preservation including literal template-like text, CRLF/BOM, non-ASCII text, malformed lists, unsafe YAML tags, empty model chain elements, inner model slashes, recognized effort suffixes, duplicates, deterministic ordering, project override, and project denial without opt-in. Missing default directories yield no agents; explicitly missing/unreadable directories fail. Reject symlink escapes from project roots, and never search parent or implicit Pi directories.
- [x] **Step 2: Run red:** `pnpm exec vitest run packages/subagent/tool-subagent-profiles/tests/profiles.spec.ts`.
- [x] **Step 3: Implement** the parser with the existing safe YAML dependency and filesystem primitives, retaining source file paths for diagnostics. Split routes at the first slash and only recognized terminal effort suffixes. Treat auxiliary metadata as diagnostic-only. Load on invocation; do not add a watcher or global cache. Give file-read failures actionable paths, not silent skips.
- [x] **Step 4: Run green**, then a Loader smoke that resolves the real package Config and proves invalid Config fails. Update the package README in this task; it describes only already implemented discovery until later tasks add execution.
- [x] **Step 5: Register packaging** following the package cookbook, use the root version and workspace dependency conventions, run `pnpm install --frozen-lockfile` only after generating the intentional lockfile update, and run the package/source-path/product-policy checks. Do not add a package bin, default bundle row, or glyph.
- [x] **Step 6: Checkpoint** discovery and its loader/packaging evidence.

### Task 4: Persist, restore, and route a profile child

**Files:** Create `src/{state,runtime}.ts`, `tests/{state,runtime,fallback,loader-composition}.spec.ts`, and a deterministic two-provider fixture within the new package. Extend its README/JSDoc and persistence history in the same task.

**Interfaces:** `SubagentProfileSnapshot` contains profile identity/description, source, literal persona, optional tools, and a non-empty resolved route array. Declare required-on-read `subagent/profile` carrying that snapshot and `subagent/profile-route` carrying `{ index: number }`. Register projection `subagentProfile` with snapshot/current index. `resolveProfile(profile: ParsedProfile, parent: Agent, signal: AbortSignal): Promise<SubagentProfileSnapshot>` validates all routes through the live adapter before start. `installProfileRuntime(childCtx: Context, child: Agent, snapshot: SubagentProfileSnapshot): void` applies persona, whole-scope restrictions, and request/recovery listeners. Register the native child-setup key `markdown-profile`; startup persists the typed snapshot, resume reads it instead of a file.

- [x] **Step 1: Write failing tests** for projection validation (duplicate snapshot, route-before-snapshot, out-of-range index), first-request persona/tools, unchanged parent, route/effort preflight, restoration after editing/deleting the file, and missing-plugin refusal through Task 1's setup key. Treat profile persona as literal text, including `{{name}}`, rather than accidentally executing a Harness template.
- [x] **Step 2: Add the central fallback test:** child completes one side-effect tool, its next request on provider A ends with `SERVER`, one admitted retry reaches provider B, final output succeeds. Assert one child id, one tool side effect, retained prior tool result, physical A/B request headers, one route transition, provider-owned retry records, and selected B after cold resume. Also test suffix clearing, no-model inheritance, single-model ordinary retries, exhausted chains, denied/exhausted policy despite unused routes, missing credentials/configuration, successful error-like text, and cancellation during backoff.
- [x] **Step 3: Run red:** `pnpm exec vitest run packages/subagent/tool-subagent-profiles/tests/state.spec.ts packages/subagent/tool-subagent-profiles/tests/runtime.spec.ts packages/subagent/tool-subagent-profiles/tests/fallback.spec.ts`.
- [x] **Step 4: Implement** child setup from persisted records before publication. `agent/request` awaits `next()` and overlays the selected physical route without carrying an old route's effort. Register the recovery wrapper with deliberate `prepend: true`; await the existing retry listener, advance exactly once only after its admitted delay, and recheck cancellation before appending the route event. Explicit multi-model exhaustion stops; no independent retry timer or budget is added. Missing credentials and preparation failures remain terminal. Non-profile agents delegate unchanged.
- [x] **Step 5: Run green and real Loader composition** with retry/profile plugins in both row orders and after retry-plugin reload. Mock adapters only; keep the actual loop, subagent manager, persistence, and tools. Assert cancellation/unload drains owned work and removes registrations; removal of the profile plugin cannot leave a running unrestricted profile child. Stop tracked exact profile children via native interruption and await native settlement notifications, not polling or cancelling unrelated siblings.
- [x] **Step 6: Record named profile persistence schemas** and their acknowledgement, regenerate the inventory, and run focused persistence checks before checkpointing. No Session-generation version bump is assumed; use the repository compatibility review to decide it.

### Task 5: Expose single, parallel, chain, and authorized resume

**Files:** Create `src/delegate.ts`, `tests/{delegate,continuation}.spec.ts`; finish `src/index.ts`, Config/tool schemas, prompt guidance, and README behavior.

**Interfaces:** Internal `executeDelegation(request: DelegationRequest, exec: ToolExecution): Promise<ToolResult>` consumes Task 3 discovery and Task 4 snapshots. Define `DelegationRequest` as one of single `{ agent, task, cwd?, resume? }`, parallel `{ tasks: Array<{ agent, task, cwd? }> }`, or chain `{ chain: Array<{ agent, task, cwd? }> }`. Start native activations with `childSetup: { key: 'markdown-profile', data: snapshot }`, native depth resolution, configured preset, and the selected initial route. Single/parallel use parent delivery; chain uses caller delivery. Child identities remain `SessionId`, never stringly typed internal ids.

- [x] **Step 1: Write failing tests** for exactly-one-mode validation, unknown agents, unauthorized project scope, complete parallel preflight, overlapping profiles, per-entry startup races, stable returned ids, and no task replay after accepted dispatch. Pin start acknowledgement/completion ownership so the same result is not delivered twice.
- [x] **Step 2: Write chain/resume tests** for `{previous}` replacement, first-step empty value, successful final text and child ids, stop on failure/refusal/token-limit/interruption, and cancellation before starting the next entry. Resume accepts only the exact parent's native child id and matching recorded profile; wrong parent/profile/Pi/Paseo handles reject. Resume does not reread profile files or grant new tools. Completed chain ids survive later failure in the tool result.
- [x] **Step 3: Run red:** `pnpm exec vitest run packages/subagent/tool-subagent-profiles/tests/delegate.spec.ts packages/subagent/tool-subagent-profiles/tests/continuation.spec.ts`.
- [x] **Step 4: Implement** orchestration through `startActivation()` and `sendMessage()`. Preflight the complete request before dispatch; use per-entry settled results for parallel startup, preserving handles for started siblings. Dispose the exact active chain child on cancellation and await teardown; do not pretend that process-loss chains resume. Render catalog guidance on assembly and reread on invocation so new definitions are discoverable. Register the native setup handler independently of tool availability so stored children can restore when the `spawn` provider reloads.
- [x] **Step 5: Run green**, the whole new package's focused specs, and Task 1/2 regression files. Add a real Loader case invoking the actual registered tool, including provider unload/reload and duplicate tool name rejection.
- [x] **Step 6: Checkpoint** the user-facing tool only when both start/continuation tests and transcript assertions pass.

### Task 6: Recorded sessions, SDK projections, and release checks

**Files:** Add authored keyless scenarios `snapshots/session/subagent-profiles/` and `snapshots/session/subagent-profiles-chain-failure/`, with scenario-local profiles and patches, canonical current-format parent/child JSONL, and readable prompt/schema sidecars. Add `packages/sdk/client/tests/subagent-profiles-projection.spec.ts` and matching owner-local JSON expectations; add `python/sdk/tests/test_subagent_profiles_projection.py` and matching JSON expectations. Add package-local real-provider e2e and a published-path smoke. Update the subagent group README, subsystem pair, generated catalogs/graphs, and the approved proposal's lifecycle when implementation ships.

- [x] **Step 1: Author failing expected output** for profile discovery/start/completion/fallback and chain failure. Extend the owning snapshot controller only where these cannot already replay; never bypass `dsh`, add normalization for arbitrary user text, or overwrite committed older Session generations.
- [x] **Step 2: Pin both SDK projections** of profile and route records plus normal final responses, following the existing translation-projection test pattern. Use the same semantic expected records in both SDKs and retain their native raw-event delivery. Run the two new focused SDK tests red before implementation/fixture support is complete.
- [x] **Step 3: Exercise scenarios** with `pnpm run test:snapshot -- -t subagent-profiles`, and refresh authored fixtures only through the explicit snapshot workflow. Run `pnpm exec vitest run packages/sdk/client/tests/subagent-profiles-projection.spec.ts` and `uv run --group test --project python/sdk pytest python/sdk/tests/test_subagent_profiles_projection.py`. Add a key-gated e2e using configured provider routes without logging secrets; report a skip when credentials are unavailable.
- [x] **Step 4: Finish documentation/generation** from source: package/subsystem contracts, model/token/KV Cache effects, package policy, generated tool/config/persistence/catalog references, and bilingual records. Run `pnpm run gen-tsconfig-paths`, the relevant generators named in `package.json`, and `pnpm run verify-persistence-changes`. Move the proposed note to `implemented/feature/` only when its behavior is implemented, update both languages to the required decision format, and repair its incoming plan link.
- [x] **Step 5: Run final verification:** focused specs and SDK/snapshot commands not already passed at the final revision, `pnpm run build:artifacts` then `pnpm run build:check`, a built `dsh` profile smoke loading the opt-in plugin, `pnpm run test:docs`, `pnpm run doc-sync`, relevant lint/workspace checks, and `git diff --check`. Do not run full unit/coverage/platform suites by default. Compare the existing documentation failures below without suppressing them.
- [x] **Step 6: Request one fresh whole-change review**, address scoped findings with regression tests, then report actual commands and any remaining failure/skip. Do not commit, push, or merge without authorization and the repository's applicable pre-push workflow.

## Existing verification findings

Before implementation, `pnpm run doc-sync` reports 41 passing gates and two failures: a prohibited commit reference in `python/sdk/uv.lock:113`, and three website suites failing with `No such built-in module: node:`. Neither source is changed by this proposal. Do not conflate these findings with passing feature checks or repair them as an unrelated feature change.

## Execution choice

The six tasks share child-setup, restriction, snapshot, and orchestration interfaces. Native execution in one session is the lower-overhead recommendation, followed by one fresh whole-change reviewer. Subagent-driven execution remains available if the user prefers independent implementer/reviewer checks per task.
