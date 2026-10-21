---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-21-subagent-profiles

[English](2026-10-21-subagent-profiles.md) | 中文

## 概述

新增读取时必需的子级 Markdown 配置快照与选定路由记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

新读取器保留版本 3 子级描述符并读取带初始化的版本 4 描述符。旧读取器拒绝描述符版本 4 以及未知必需事件 subagent/profile 或 subagent/profile-route，而非在缺少限制时恢复。快照不可变、路由非空、迁移每次恰好前进一步，初始化处理器缺失时拒绝恢复。不重新解释现有判别值，SessionHeader.version 不变。

<a id="verification"></a>
## 验证

19 个文件的 660 个针对性测试通过，覆盖子级初始化取消、作用域与 PTC 工具拒绝、并行父级隔离、提供方策略回退且不重放工具、冷恢复校验、链取消、manifest 校验及 TypeScript SDK 事件交付。无密钥 dsh headless 场景记录实际 A/B 路由与链令牌上限失败；Python SDK 投影测试通过。

<a id="dev-note"></a>
## 开发备注

无。
