---
description: "Native Markdown subagent profiles for operators selecting named delegation, same-session fallback, and continuation."
kind: package-reference
---

# Markdown subagent profiles

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent-profiles` is an opt-in Host plugin over native in-process subagents. It reads compatible Markdown definitions without Pi or Paseo, applies child-scoped instructions and tool restrictions, and exposes single, parallel, chain, and authorized continuation through one tool. Mount it after a fresh local subagent provider with native depth-limit support; an independent base preset also requires that provider's preset capability. It is not part of the default bundles.

## Table of Contents

- [Configuration and definitions](#configuration-and-definitions)
- [Delegation and recovery](#delegation-and-recovery)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration and definitions

Configure `provider` (default `spawn`), `toolName` (default `subagent_profiles`), optional `userDirectory`, `includeProjectAgents` (default `false`), optional `agentPreset`, and optional numeric `maxDepth`. Omitted depth reads the native Host setting. Without an independent preset, startup uses the parent's retained composition; cold resume uses the parent's current composition. Profile restrictions cannot grant missing capabilities.

Definitions are `$DSH_HOME/agents/*.md`; `userDirectory` replaces that directory and may explicitly point at existing Pi files. Project discovery reads only the original Session project's `.dsh/agents/*.md`, requires operator opt-in, and rejects symlink escapes. Project names override user names; duplicates within a scope fail. Missing default directories are empty; unreadable or explicitly missing directories fail.

```markdown
---
name: reviewer
description: Review changes without modifying files
tools: read, bash
model: provider-a/vendor/model:high, provider-b/model
---
Review the change and report concrete findings with file locations.
```

`name` and `description` are required nonempty strings. Optional `tools` accepts a comma-separated string or string array; an empty list permits no end-capability tools, while omission keeps the native composition. Names must exist in the selected composition. Enforcement covers scoped tools, future registrations, native calls, and nested PTC calls; the PTC transport itself stays available. Optional `model` is an ordered comma-separated chain, split at each reference's first slash. Recognized effort suffixes are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; the live adapter validates support. Omission captures the parent's effective route. Configure providers and credentials in Harness; no aliases or credentials are imported.

YAML is data-only. The body is literal persona text, including template-like braces. Additional metadata produces explicit no-effect diagnostics; it does not activate Pi skills, extensions, MCP, or permission behavior. Definitions are reread for discovery and new delegations, not for existing children.

## Delegation and recovery

Exactly one input mode is accepted: `{ agent, task, cwd? }`, `{ tasks: [{ agent, task, cwd? }] }`, or `{ chain: [{ agent, task, cwd? }] }`. Single and parallel calls return native child ids immediately; completion arrives through native parent notices. Parallel preflight validates every definition, route, tool restriction, and directory before starting work. Subsequent startup races return per-entry errors alongside accepted child ids; dispatched tasks are never restarted for reporting failures.

Chains await each native child with caller delivery, replacing every `{previous}` with the prior successful final text (initially empty). A failed, interrupted, empty, or incomplete final result stops the chain and retains started child ids. Cancellation disposes the active child and awaits teardown. Continue with `{ agent, task, resume }`: the native child must belong to the exact live parent and match its recorded profile. Resume preserves the snapshot, route choice, restrictions, and directory; omit `cwd`. Pi/Paseo handles are unsupported.

The child persists `subagent/profile` and each selected `subagent/profile-route` before requests use them. Native registered child setup is required on cold resume; a missing plugin refuses restoration. The existing provider retry executor alone admits and delays fallback. Each admitted retry advances a multi-model profile once in the same Session, retaining completed tool results. Denied or exhausted policy and exhausted explicit chains terminate. Single-model profiles keep ordinary retries. Missing/invalid credentials, authentication failures, preparation failures, tool failures, and successful error-like answers do not advance routes. Targets without an effort suffix use their own adapter defaults.

Plugin unload cancels invocations and drains only its profile children before scoped registrations are released. Provider unload removes the tool but leaves setup available for native cold continuation; provider reload registers the tool again. Duplicate setup/tool registrations fail loudly.

## Dev Note

The native subagent manager owns capacity, publication, continuation, and teardown; this plugin owns only profile data and routing decisions.

## Model Experience

### Catalog guidance

#### What the model sees

A `Markdown agents for <toolName>:` section lists current names/descriptions and diagnostic-only metadata. It appears only when the tool definition is visible in that scope. Discovery errors fail assembly rather than silently hiding a configuration problem.

#### Token effect

Catalog length varies with enabled definitions and metadata. The selected child's literal persona and retained task/history consume independent child-request tokens.

#### KV Cache effect

Editing catalog descriptions or definitions can replace parent prompt tokens. Child persona remains stable from its persisted snapshot. Cross-provider fallback can lose provider-side prefix reuse.

### Tool schemas and results

#### What the model sees

The [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-profiles) records its schema. The tool accepts one mode plus native resume; results contain accepted child ids, per-entry failures, metadata diagnostics, or final chain text. Intermediate chain children do not send duplicate parent completion notices.

#### Token effect

One tool schema is present while its provider is registered. Start acknowledgements grow with entries; final chain text and subsequent completion notices remain in parent history until compaction.

#### KV Cache effect

Tool schemas stay stable while configuration and provider availability are unchanged. Results append to history; provider unload/reload changes the visible schema set.

## Known Limitations and Deferred Work

- **No chain crash recovery** — process loss does not automatically replay or resume sequential work.
- **Configuration compatibility is not runtime portability** — Harness must provide matching tools, provider routes, reasoning efforts, and credentials; inert Pi metadata remains diagnostic-only.
- **No exactly-once remote guarantee** — same-Session fallback avoids deliberate tool replay but cannot establish unknown provider-side outcomes after transport failure.
