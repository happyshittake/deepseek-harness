---
description: "为操作者提供具名委派、同会话回退和继续执行的原生 Markdown 子代理配置。"
kind: package-reference
---

# Markdown 子代理配置

[English](README.md) | 中文

## 概述

`dsh-tool-subagent-profiles` 是基于原生进程内子代理的按需启用 Host 插件。它读取兼容的 Markdown 定义，不依赖 Pi 或 Paseo，应用子级作用域指令与工具限制，并通过一个工具提供单任务、并行、链和授权继续执行。在支持原生深度限制、创建全新本地子级的提供方之后挂载；独立基础预设还要求该提供方支持预设选择。默认组合包不包含它。

## 目录

- [配置与定义](#configuration-and-definitions)
- [委派与恢复](#delegation-and-recovery)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration-and-definitions"></a>
## 配置与定义

配置 `provider`（默认 `spawn`）、`toolName`（默认 `subagent_profiles`）、可选 `userDirectory`、`includeProjectAgents`（默认 `false`）、可选 `agentPreset` 与可选数字 `maxDepth`。省略深度时读取原生 Host 设置。没有独立预设时，启动采用父级保留的组合，冷恢复采用父级当前组合。配置文件限制不能授予缺失能力。

定义位于 `$DSH_HOME/agents/*.md`；`userDirectory` 替换该目录，可显式指向现有 Pi 文件。项目发现仅读取原始 Session 项目的 `.dsh/agents/*.md`，必须由操作者启用，并拒绝符号链接逃逸。项目名称覆盖用户名称；同一范围内重名则失败。默认目录缺失表示为空；目录不可读或显式目录缺失则失败。

```markdown
---
name: reviewer
description: Review changes without modifying files
tools: read, bash
model: provider-a/vendor/model:high, provider-b/model
---
Review the change and report concrete findings with file locations.
```

`name` 与 `description` 必须是非空字符串。可选 `tools` 接受逗号分隔字符串或字符串数组；空列表不允许任何最终能力工具，省略时保留原生组合。名称必须存在于所选组合中。强制执行覆盖作用域工具、后续注册、原生调用和嵌套 PTC 调用；PTC 传输本身保留。可选 `model` 是有序逗号分隔链，每个引用在第一个斜杠处分割。识别的推理强度后缀为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 和 `max`；实时适配器校验支持情况。省略时捕获父级有效路由。在 Harness 中配置提供方和凭据；不导入别名或凭据。

YAML 仅作为数据。正文是字面角色指令文本，包括类似模板的大括号。其他元数据产生明确的无效果诊断，不激活 Pi 技能、扩展、MCP 或权限行为。发现与新委派重新读取定义；现有子级不重新读取。

<a id="delegation-and-recovery"></a>
## 委派与恢复

恰好接受一种输入模式：`{ agent, task, cwd? }`、`{ tasks: [{ agent, task, cwd? }] }` 或 `{ chain: [{ agent, task, cwd? }] }`。单任务和并行调用立即返回原生子级 id；完成通过原生父级通知到达。并行预检在启动工作前验证每个定义、路由、工具限制和目录。后续启动竞态逐项返回错误并保留已接受子级 id；不会因报告失败而重新启动已分发任务。

链使用调用方交付等待每个原生子级，将所有 `{previous}` 替换为前一个成功的最终文本，初值为空。失败、中断、空或不完整最终结果会停止链，并保留已启动子级 id。取消会释放活动子级并等待清理。通过 `{ agent, task, resume }` 继续：原生子级必须属于确切在线父级并匹配记录的配置。继续执行保留快照、路由选择、限制和目录；省略 `cwd`。不支持 Pi/Paseo 句柄。

子级在请求使用前持久化 `subagent/profile` 和每次选定的 `subagent/profile-route`。冷恢复要求原生已注册子级初始化；插件缺失时拒绝恢复。现有提供方重试执行器独占回退准入与延迟。每次准入重试在同一 Session 中使多模型配置前进一步，保留已完成工具结果。策略拒绝或耗尽、显式链耗尽均终止。单模型配置保留普通重试。凭据缺失/无效、身份验证失败、准备失败、工具失败及包含错误样式文本的成功回答均不会推进路由。目标省略强度后缀时使用自身适配器默认值。

插件卸载会取消调用，并在释放作用域注册前仅等待其配置文件子级结束。提供方卸载会移除工具，但保留初始化以支持原生冷继续执行；提供方重新加载后再次注册工具。重复初始化或工具注册会明确失败。

<a id="dev-note"></a>
## 开发备注

原生子代理管理器负责容量、发布、继续执行与清理；本插件仅负责配置数据与路由决策。

<a id="model-experience"></a>
## 模型体验

### 目录指导

#### 模型看到什么

`Markdown agents for <toolName>:` 段列出当前名称/描述以及仅诊断的元数据。仅当该作用域可见工具定义时出现。发现错误使组装失败，不会静默隐藏配置问题。

#### Token 影响

目录长度随启用定义和元数据变化。所选子级字面角色指令及保留任务/历史消耗独立子级请求 token。

#### KV Cache 影响

编辑目录描述或定义可能替换父级提示 token。子级角色指令根据持久化快照保持稳定。跨提供方回退可能失去提供方前缀复用。

### 工具 schema 与结果

#### 模型看到什么

[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-profiles)记录其 schema。工具接受一种模式及原生继续执行；结果包含已接受子级 id、逐项失败、元数据诊断或最终链文本。中间链子级不会重复向父级发送完成通知。

#### Token 影响

提供方注册期间存在一个工具 schema。启动确认随条目增加；最终链文本和后续完成通知保留在父级历史中直至压缩。

#### KV Cache 影响

配置和提供方可用性不变时工具 schema 稳定。结果追加到历史；提供方卸载/重新加载改变可见 schema 集合。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **无链崩溃恢复**——进程丢失后不会自动重放或恢复顺序工作。
- **配置兼容不等于运行时可移植**——Harness 必须提供匹配工具、提供方路由、推理强度和凭据；无效的 Pi 元数据仅作诊断。
- **无远程恰好一次保证**——同会话回退避免主动重放工具，但无法确认传输失败后的未知提供方结果。
