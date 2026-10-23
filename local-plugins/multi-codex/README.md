# @local/multi-codex

English | [中文](README.zh.md)

A local DeepSeek Harness port of the pi extension `~/.pi/agent/extensions/codex-multi.ts`: several ChatGPT Codex OAuth accounts behind the provider route `multi-codex/<model>`.

## Installation

This standalone local bundle is outside the DSH workspace packages and is not enabled by shipped profiles. Install dependencies from this directory with `pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts`, then install this absolute directory through Harness Plugin Manager (`install_bundle`). No credentials or account state are included in the repository.

## Capabilities

- Registers **OpenAI Codex (multi)** in the model picker using the installed pi-ai Codex model catalog. Actual model access depends on the selected account.
- New conversations select the least-assigned healthy account and remain sticky for cache locality. Pre-output rate-limit/auth failures add shared cooldowns and select another account.
- Accounts, OAuth tokens, and routing reservations share the pi agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`), including `auth.json.lock` and `multi-codex-routing.json.lock`.
- Token refresh uses the shared auth lock, reusing credentials refreshed by another process to avoid double-refreshing rotating tokens.
- Provides `multi_codex_image` for PNG generation and edits, plus `/multi-codex-auth` for account management.

## Commands

```text
/multi-codex-auth list
/multi-codex-auth use <label|default>
/multi-codex-auth login <label> [device]
/multi-codex-auth cancel <label>
```

`list` displays auth status, cooldowns, leases, and pending login instructions. `use` selects an account for the session. `login` starts background browser OAuth or device-code login; `cancel` aborts a pending login.

Browser login uses the loopback callback on port 1455, shared with the Codex CLI. If that port is busy, log in through pi instead; the account appears here because both read the same auth store.

## Notes

- Leases renew on requests and once a minute while the plugin runs. After its process stops, remaining leases expire within five minutes.
- The image tool resolves output paths against the session working directory and refuses to overwrite existing files.
- Direct pi-ai provider calls normalize the context before dispatch so the initial system prompt and tool declarations reach the provider.
