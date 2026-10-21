---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-20-subagent-child-setup

[English](2026-10-20-subagent-child-setup.md) | 中文

## 概述

为可继续子代理描述符增加已注册的本地子级初始化。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

现有版本 3 描述符字段不变并继续可读。仅带初始化的子级写入包含必需处理器键的版本 4 描述符。旧读取器拒绝该描述符版本，不会在缺少初始化时恢复；当前读取器拒绝缺失处理器。初始化处理器单独持久化功能数据。SessionHeader.version 不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/subagent/subagent/tests/{child-setup,activation-policy,continuation,continuation-presets,external-activation,catalog}.spec.ts：227 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
