---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-20-subagent-child-setup

English | [中文](2026-10-20-subagent-child-setup.zh.md)

## Summary

Adds registered local child setup to the continuable subagent descriptor.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-20-subagent-child-setup
baseline: false
changes:
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "566fbf4a25b3832589cd37349104caf7debd74b121f0ffd9d6670a4ea13f41af"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing version-3 descriptors retain their exact fields and remain readable. Only setup-backed children write descriptor version 4 with a required initializer key. Older readers refuse that descriptor version rather than restore without its setup; current readers refuse missing handlers. The initializer persists feature data separately. SessionHeader.version is unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/subagent/subagent/tests/{child-setup,activation-policy,continuation,continuation-presets,external-activation,catalog}.spec.ts: 227 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
