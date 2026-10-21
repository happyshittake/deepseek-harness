---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-21-subagent-profiles

English | [中文](2026-10-21-subagent-profiles.zh.md)

## Summary

Adds required child-owned Markdown profile snapshots and selected-route records.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-21-subagent-profiles
baseline: false
changes:
  - root: "event:subagent/profile"
    previous: null
    after: "d7bbaf288e45aec69a137d716c68b0a71bb20584a8485b5e9602add7804fac6f"
    decision: same-version
  - root: "event:subagent/profile-route"
    previous: null
    after: "78daebfce54a93d2d5f893689f2905302ed9f0f3fdef93a6bcf178495214037f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers retain version-3 child descriptors and read version-4 setup-backed descriptors. Older readers refuse descriptor version 4 and unknown required subagent/profile or subagent/profile-route events, rather than resume without restrictions. The snapshot is immutable, routes are nonempty, route transitions advance exactly once, and absent setup handlers refuse restoration. No existing discriminator is reinterpreted and SessionHeader.version remains unchanged.

<a id="verification"></a>
## Verification

660 focused tests passed across 19 files, including child setup cancellation, scoped and PTC tool denial, parallel parent isolation, provider-policy fallback without tool replay, cold resume validation, chain cancellation, manifest validation, and TypeScript SDK event delivery. Keyless dsh headless scenarios record physical A/B routes and chain max-token failure; Python SDK projection test passed.

<a id="dev-note"></a>
## Dev Note

None.
