# Agent Note: Markdown subagent profiles with native model fallback

Status: implemented

English | [中文](2026-10-20-markdown-subagent-profiles.zh.md)

## Problem

The user maintains Pi subagent definitions as Markdown files and needs the same delegation workflow inside Harness without Pi, Paseo, or another agent executable. Existing native subagents supply lifecycle, presets, continuation, and model routes but lack Markdown discovery and ordered cross-provider fallback.

## Decision

One opt-in [Host plugin](../../../../packages/subagent/tool-subagent-profiles/README.md) owns discovery, profile snapshots, routing, and single/parallel/chain/resume input. It uses managed fresh local children rather than another orchestration system, and does not change the agent loop or default bundles.

User definitions come from `$DSH_HOME/agents/*.md` or an explicit operator directory, including a deliberately selected existing Pi directory. Project `.dsh/agents/*.md` discovery requires operator opt-in, stays beneath the original project, and rejects symlink escapes. Definitions are reread for new work. Extra Pi metadata produces diagnostics, not unsupported capability claims; Harness remains responsible for actual tools, providers, credentials, and effort support.

The native manager exposes registered child setup with isolated startup JSON and initialization cancellation. Setup runs after native composition and before publication. A version-4 child descriptor stores the required initializer key; ordinary children retain their version-3 descriptors. Missing or replaced handlers refuse initialization. The profile snapshot is a separate required Session event, so cold resume never rereads changed Markdown. A configured base preset is mounted through the native preset mechanism; omission retains native parent-composition behavior, including the parent's current composition on cold resume.

Whole-scope tool restrictions are opt-in on the existing registry. They constrain inherited and local capabilities, late registrations, and execution through native and nested PTC calls without changing the legacy own-scope exemption. A profile cannot grant a missing tool. Empty lists deny all end-capability tools while retaining PTC transport infrastructure.

The existing provider-owned retry executor alone admits and delays recovery. A multi-model profile advances once only after durable retry-start evidence, retains one child Session and completed tool results, and logs the selected route before its next request. Exhausted policy or an exhausted explicit chain terminates; single-model profiles keep ordinary retries. Cancellation, credential/authentication failures, configuration/preparation failures, tool errors, and successful error-like answers do not advance routes. Routes use registered Harness provider/model ids; only recognized terminal suffixes denote effort, so other model-id colons remain literal. Cold resume validates the selected route before publication, and normal preparation validates every request against its live adapter.

Single and parallel modes acknowledge native child ids and use native completion notices. Full preflight precedes dispatch; parallel startup races preserve successful siblings' ids. Chains use caller delivery, await successful final text, substitute `{previous}`, and stop without starting later entries after failure, incomplete output, or cancellation. Native resume requires the exact parent and recorded profile identity, retains the logged directory, and rejects a new `cwd`. Plugin unload cancels invocations and drains only its own children; provider unload removes the tool without removing restoration support.

## Alternatives considered

**Invoke Pi or Paseo externally.** This retains separate runtime, credential, process, and continuation dependencies and contradicts the required Harness-only execution.

**Require YAML presets for every role.** Native presets remain the base composition mechanism, but alone neither preserve the Markdown workflow nor supply ordered fallback and chain input.

**Replace a failed child on another model.** Restarting loses stable continuation identity and risks repeating completed tools. Route changes instead operate inside the existing Session.

## Consequences

Markdown compatibility does not make tool names, provider aliases, credentials, or effort values portable. Auxiliary metadata does not reproduce Pi skills or extensions. Profiles restrict capabilities and supply trusted instructions; they are not independent process security sandboxes.

Fallback can lose provider KV Cache reuse and incur additional billed requests. Keeping one Session avoids deliberate tool replay, but does not establish exactly-once provider work after an unknown network outcome. Chains have no automatic crash recovery. External runners, scheduling, new UI, settings migration, and a complete Pi compatibility layer remain outside this plugin.

Required profile events and versioned descriptors let older readers refuse unfamiliar children rather than drop restrictions. Focused lifecycle/permission tests, keyless shipped-profile snapshots with physical route changes and chain failure, both SDK projections, and persistence acknowledgements retain those guarantees. Real-provider verification remains key-gated.
