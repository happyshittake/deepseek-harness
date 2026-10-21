# Markdown Subagent 配置实现计划

> **面向 agent 实现者：** 必须使用子 skill（技能）superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项执行本计划。步骤采用复选框（`- [ ]`）跟踪。

[English](2026-10-20-markdown-subagent-profiles.md) | 中文

**目标：** 根据兼容的 Markdown agent（智能体）定义提供原生 Harness 委派，支持有序跨提供方回退且不替换子 agent Session。

**架构：** 一个按需启用的 Host 插件 `@deepseek-ai/dsh-tool-subagent-profiles` 提供配置发现、子 agent 初始化、路由和面向模型的工具。为现有 subagent 管理器增加可注册、可恢复的子 agent 初始化，并为工具注册表增加按需启用的完整作用域限制。保持 agent loop（智能体循环）、默认组合包和现有委派行为不变。

**技术栈：** TypeScript ESM、Cordis、现有 `js-yaml` 与 Zod、原生 subagent 激活、Session 投影、Vitest，以及已发布 profile 的快照重放；不依赖 Pi/Paseo。

**设计：** [已批准的提案](../../../.agents/notes/implemented/feature/2026-10-20-markdown-subagent-profiles.zh.md)。实现步骤与本地验证已执行；包 README 记录支持行为，既有文档检查失败另行记录。

## 全局约束

- 运行时仅使用 Harness；通过受支持的 `dsh` profile 启动，不新增可执行程序或 SDK argv 绕行入口。
- 使用 `$DSH_HOME/agents/*.md` 和原始项目的 `.dsh/agents/*.md`；项目发现必须由操作者启用，不隐式查找 Pi 路径。
- 单任务和并行运行返回原生子 agent id；链等待结果；继续执行仅支持单任务模式，并由原生继续执行管理器授权。
- 多模型链仅在提供方策略准入的重试中前进；链耗尽即终止，单模型配置保留普通重试，不主动重放已完成工具。
- 通过持久化子 agent 记录保留角色指令、工具限制和选定路由；已配置的提供方凭据与兼容工具名仍是前提。
- 所有注册均为有所有者的副作用。校验文件、工具和持久化输入，不新增 `as unknown`，更新受影响的双语文档和持久化声明，保留已提交的 Session 代际文件。
- 不在默认组合包启用插件，不增加 UI 或图标，不导入 Pi 设置，也不实现链崩溃恢复。

## 审查重点

- 格式错误的 `tools` 值与显式空列表绝不能扩大子 agent 权限；在任务 2 和 3 中测试。
- `gateway/vendor/model:high` 之类的路由必须保留内部斜杠，按条件清除上一条路由的推理强度，并拒绝不受支持的强度；在任务 3 和 4 中测试。
- 两个重叠委派不能交换配置、工具列表、路由状态或清理所有权；在任务 1 和 5 中测试。
- 修改或删除 Markdown，以及缺少初始化插件，都不能静默改变冷恢复的子 agent；在任务 1 和 4 中测试。
- 重试延迟、并行启动或链完成期间的取消不能意外启动后续工作，且必须恰好释放拥有的子 agent；在任务 4 和 5 中测试。

---

## 文件职责

`packages/subagent/tool-subagent-profiles/src/` 包含 `index.ts`（Config 与有所有者的注册）、`profiles.ts`（Markdown 解析与发现）、`types.ts`（配置及请求/结果类型）、`state.ts`（持久化配置与路由投影）、`runtime.ts`（子 agent 角色指令、限制与路由）以及 `delegate.ts`（单任务、并行、链与继续执行）。测试与真实 loader fixture（测试前置数据）位于该包的 `tests/`。不新增第二套 agent 工厂、提供方 SDK 或通用工作流引擎。

现有原生代码修改限定在 `packages/subagent/subagent/src/{types,index,descriptor,manager}.ts` 和 `packages/core/tools/src/index.ts`，同时更新测试及所属 README/子系统双语文件。打包修改涉及新包 manifest（元数据清单）和 tsconfig、`tsconfig.host.json`、生成的源路径映射、`scripts/product-package-policy.ts` 与 `pnpm-lock.yaml`。Session 快照位于 `snapshots/session/`，SDK 投影预期文件留在其所属目录。

### 任务 1：可恢复的原生子 agent 初始化

**文件：** 修改 `packages/subagent/subagent/src/{types,index,descriptor,manager}.ts`；新增 `packages/subagent/subagent/tests/child-setup.spec.ts`；更新 subagent README 与 `docs/subsystems/subagent.md` 双语文件。

**接口：** 导出具有 `key: string` 与 `data: JsonValue` 的 `SubagentChildSetup`；在 `SubagentActivationSpec` 而非提供方请求中增加可选 `childSetup`。导出处理器，参数为 `(childCtx: Context, child: Agent, input: { kind: 'startup'; data: JsonValue } | { kind: 'resume' })`，返回 `void | Promise<void>`。增加 `ctx.subagents.registerChildSetup(key, handler): () => void`；注册重复或缺失时明确失败。使用 `dsh-util-values` 的 `JsonValue` 与现有品牌化 Session id。

- [x] **步骤 1：编写失败测试**，涵盖两个并发启动的数据隔离、发布和首次请求前初始化、初始化拒绝后的回滚、外部后端分发前拒绝、重复注册、资源释放、冷恢复以及缺失处理器时拒绝。断言现有未扩展描述符仍为版本 `3`；带初始化的描述符使用版本 `4`，仅增加一个 `childSetup` 键，且版本 `3` 的读取行为保持不变。
- [x] **步骤 2：运行红灯测试：** `pnpm exec vitest run packages/subagent/subagent/tests/child-setup.spec.ts`。实现前应因 API 或类型缺失失败，而非因依赖缺失失败。
- [x] **步骤 3：实现** 实例所有、通过副作用管理的初始化注册表。在首次 await 前对启动 JSON 创建快照。具体化之前解析处理器，将必需键追加到带初始化的描述符，并在现有工厂的未发布初始化阶段、预设与策略初始化之后调用。冷恢复根据持久化键解析同一处理器，不提供启动数据，并在发布子 agent 前调用。处理器负责持久化其功能数据；不要在描述符中重复保存快照。保留版本 3 的键校验，明确新增版本 4 校验，绝不将未知版本重新解释为版本 3。保持提供方 API 与 agent loop 不变。
- [x] **步骤 4：验证绿灯与回归：** 在 `packages/subagent/subagent/tests/` 中运行新测试以及 `activation-policy.spec.ts`、`continuation.spec.ts`、`continuation-presets.spec.ts`、`external-activation.spec.ts` 与 `catalog.spec.ts`。断言初始化失败不发布可用子 agent，也不占用容量。
- [x] **步骤 5：记录持久化变更**，使用仓库记录命令与经过审查的双语说明，涵盖旧读取器拒绝描述符版本 4，以及继续支持版本 3。运行针对性检查。仅在实现引入外部可感知的不兼容变更时创建升级指南；不要仅为支持配置文件子 agent 而破坏现有子 agent。
- [x] **步骤 6：建立检查点：** 审查针对性差异；仅在获准提交时提交这些文件及其必需文档和历史记录，否则保留为未提交的任务检查点。

### 任务 2：在整个子 agent 作用域强制执行配置限制

**文件：** 修改 `packages/core/tools/src/index.ts`、`packages/core/tools/tests/scoped.spec.ts`、`packages/core/tools/tests/ptc.spec.ts`、tools README 双语文件及 `docs/subsystems/tools.md` 双语文件。

**接口：** 扩展 `ToolRuntime.restrict(filter: ToolRestriction, options?: { readonly includeScoped?: boolean }): () => void`。省略 `includeScoped` 时保留当前针对继承工具的限制。设为 `true` 时，允许/拒绝限制也覆盖子 agent 自身作用域注册的最终能力工具。不要向 `ToolRestriction` 增加持久化属性，也不要改变历史描述符过滤器。

- [x] **步骤 1：编写失败测试**，断言 `includeScoped: true` 会通过 schema/get 查询、原生执行和 PTC 嵌套分发屏蔽并拒绝同作用域的禁用工具，包括在设置限制后才注册的工具。断言空 `allow: []` 拒绝所有最终能力工具、允许的本地名称可以通过校验、祖先作用域限制取交集、父和兄弟作用域不变，以及资源释放后恢复可见性。固定未启用选项时保留的自身作用域豁免。保留 `run_code` 传输在能力过滤之外，但拒绝其中被禁止的嵌套调用。
- [x] **步骤 2：运行红灯测试：** `pnpm exec vitest run packages/core/tools/tests/scoped.spec.ts packages/core/tools/tests/ptc.spec.ts`。
- [x] **步骤 3：实现** 现有限制条目和统一注册表视图中的选项，在作用域覆盖处理之后、展示传输插入之前应用完整作用域过滤。根据相应的完整能力集合校验名称，并在执行时使用同一个过滤视图。仅当真实的其他执行路径绕过该视图时使用现有单调 guard；不要增加冗余强制执行层。
- [x] **步骤 4：运行绿灯测试**，包括这两个文件，以及 `packages/core/tools/tests/tools.spec.ts` 与 `packages/core/tools/tests/ptc-calls.spec.ts`。通过断言而非提示文本确认资源释放和其他分发路径拒绝行为。
- [x] **步骤 5：建立检查点**，保留按需启用的行为及其所属文档，不改变默认限制语义。

### 任务 3：新增可选包与 Markdown 发现

**文件：** 创建新包的 `package.json`、`tsconfig.json`、`src/{index,types,profiles}.ts`、`tests/profiles.spec.ts`、`tests/fixtures/loader/cordis.yml`、README 双语文件与语言文件。在 `tsconfig.host.json` 和 `scripts/product-package-policy.ts` 中将其登记为 `optional`；重新生成源路径并更新 `pnpm-lock.yaml`。

**接口：** `parseProfile(text: string, filePath: string, source: 'user' | 'project'): ParsedProfile`；`discoverProfiles(spec: ProfileDiscoverySpec, signal: AbortSignal): Promise<ProfileCatalog>`。`ParsedProfile` 包含 `name`、`description`、`persona`、可选 `tools` 与可选有序路由；`ProfileCatalog` 包含定义和诊断。`ProfileRoute` 包含提供方、模型以及可选品牌化推理强度。发现参数包含已解析的操作者目录路径和项目启用选项，不包含模型选择的文件系统路径。

**配置决定：** `toolName` 默认为 `subagent_profiles`；`provider` 默认为 `spawn`；`userDirectory` 可选，用于替换 `dshHomePath('agents')`；`includeProjectAgents` 默认为 `false`；可选 `agentPreset` 选择子 agent 基础组合；可选数字 `maxDepth`，省略时使用 `subagents.resolveMaxDepth()`。在 Host 上挂载一个实例，并要求本地新建子 agent 提供方。在执行前明确解析配置默认值。使用已安装的 `js-yaml` 并将其声明为运行时依赖，而非使用 Pi 的 frontmatter 解析器。

- [x] **步骤 1：编写失败的解析和发现测试**，涵盖用户的四字段格式与当前辅助元数据、字符串/数组/空工具列表、正文保留（包括类似模板的字面文本）、CRLF/BOM、非 ASCII 文本、无效列表、不安全 YAML 标签、空模型链条目、模型内部斜杠、已识别推理强度后缀、重名、确定性顺序、项目覆盖及未启用项目时拒绝。默认目录不存在表示无 agent；显式目录不存在或不可读则失败。拒绝逃出项目根目录的符号链接，不搜索父目录或隐式 Pi 目录。
- [x] **步骤 2：运行红灯测试：** `pnpm exec vitest run packages/subagent/tool-subagent-profiles/tests/profiles.spec.ts`。
- [x] **步骤 3：实现** 使用现有安全 YAML 依赖和文件系统原语的解析器，保留源文件路径以提供诊断。按第一个斜杠拆分路由，仅识别已约定的末尾推理强度后缀。辅助元数据只产生诊断。在调用时加载，不增加 watcher 或全局缓存。文件读取失败必须给出可操作的路径信息，而非静默跳过。
- [x] **步骤 4：运行绿灯测试**，然后通过 loader 冒烟测试解析真实包 Config，并验证无效 Config 失败。在本任务中更新包 README；后续任务增加执行前，只描述已实现的发现行为。
- [x] **步骤 5：登记打包信息**，遵循包实操手册、根版本和 workspace 依赖规范，仅在生成预期锁文件更新后运行 `pnpm install --frozen-lockfile`，并执行包、源路径和产品策略检查。不增加包 bin、默认组合包配置项或图标。
- [x] **步骤 6：建立检查点**，包含发现功能及其 loader 和打包验证依据。

### 任务 4：持久化、恢复并路由配置文件子 agent

**文件：** 创建 `src/{state,runtime}.ts`、`tests/{state,runtime,fallback,loader-composition}.spec.ts`，以及新包内确定性的双提供方 fixture。在同一任务中扩展 README/JSDoc 和持久化历史。

**接口：** `SubagentProfileSnapshot` 包含配置身份/描述、来源、字面角色指令、可选工具列表及非空已解析路由数组。声明读取时必需的 `subagent/profile`（携带快照）和 `subagent/profile-route`（携带 `{ index: number }`）。注册保存快照及当前索引的投影 `subagentProfile`。`resolveProfile(profile: ParsedProfile, parent: Agent, signal: AbortSignal): Promise<SubagentProfileSnapshot>` 在启动前通过实时适配器校验所有路由。`installProfileRuntime(childCtx: Context, child: Agent, snapshot: SubagentProfileSnapshot): void` 应用角色指令、完整作用域限制以及请求/恢复监听器。注册原生子 agent 初始化键 `markdown-profile`；启动时持久化类型化快照，恢复时读取快照而非文件。

- [x] **步骤 1：编写失败测试**，涵盖投影校验（重复快照、快照前路由事件、索引越界）、首次请求的角色指令与工具、父 agent 不变、路由和推理强度预检、文件修改/删除后的恢复，以及通过任务 1 初始化键实施的缺失插件拒绝。将配置文件角色指令视为字面文本，包括 `{{name}}`，不得意外执行 Harness 模板。
- [x] **步骤 2：新增核心回退测试：** 子 agent 完成一个有副作用的工具，其在提供方 A 的下一请求以 `SERVER` 结束，一次准入重试到达提供方 B，最终输出成功。断言仅有一个子 agent id、一次工具副作用、保留前序工具结果、实际 A/B 请求头、一次路由迁移、提供方所属重试记录，以及冷恢复后继续选用 B。同时测试后缀清除、未指定模型时继承、单模型普通重试、链耗尽、仍有未使用路由时策略拒绝/预算耗尽、凭据或配置缺失、包含类似错误文本的成功回答，以及退避期间取消。
- [x] **步骤 3：运行红灯测试：** `pnpm exec vitest run packages/subagent/tool-subagent-profiles/tests/state.spec.ts packages/subagent/tool-subagent-profiles/tests/runtime.spec.ts packages/subagent/tool-subagent-profiles/tests/fallback.spec.ts`。
- [x] **步骤 4：实现** 发布前根据持久化记录进行子 agent 初始化。`agent/request` 等待 `next()` 并覆盖选定物理路由，不携带旧路由推理强度。明确以 `prepend: true` 注册恢复包装器；等待现有重试监听器，仅在其准入延迟完成后前进一步，并在追加路由事件前再次检查取消。显式多模型链耗尽即停止；不增加独立重试计时器或预算。凭据缺失与准备错误保持终止行为。非配置文件 agent 的委托行为不变。
- [x] **步骤 5：运行绿灯与真实 loader 组合测试**，涵盖重试/配置插件两种配置项顺序以及重试插件重新加载之后的行为。仅 mock（测试替身）适配器；保留实际循环、subagent 管理器、持久化和工具。断言取消/卸载会等待所属工作结束并移除注册；移除配置插件不能留下正在运行、失去限制的配置文件子 agent。通过原生中断停止所跟踪的确切配置文件子 agent，并等待原生完成通知，不轮询也不取消无关兄弟任务。
- [x] **步骤 6：记录具名配置持久化 schema** 及其变更确认，重新生成清单，并在建立检查点前运行针对性持久化检查。不预设需要增加 Session 代际版本；通过仓库兼容性审查决定。

### 任务 5：提供单任务、并行、链与授权继续执行

**文件：** 创建 `src/delegate.ts`、`tests/{delegate,continuation}.spec.ts`；完成 `src/index.ts`、Config/工具 schema、提示指导与 README 行为说明。

**接口：** 内部函数 `executeDelegation(request: DelegationRequest, exec: ToolExecution): Promise<ToolResult>` 使用任务 3 的发现和任务 4 的快照。将 `DelegationRequest` 定义为单任务 `{ agent, task, cwd?, resume? }`、并行 `{ tasks: Array<{ agent, task, cwd? }> }` 或链 `{ chain: Array<{ agent, task, cwd? }> }` 之一。通过 `childSetup: { key: 'markdown-profile', data: snapshot }`、原生深度解析、配置预设和选定初始路由启动原生激活。单任务/并行使用父 agent 交付，链使用调用方交付。内部子 agent 身份保持为 `SessionId`，不使用无类型字符串 id。

- [x] **步骤 1：编写失败测试**，涵盖恰好一种模式的校验、未知 agent、未授权项目范围、完整并行预检、重叠配置、逐项启动竞态、稳定返回 id，以及已接受分发后不重放任务。固定启动确认与完成结果的所有权，避免同一结果交付两次。
- [x] **步骤 2：编写链与继续执行测试**，涵盖 `{previous}` 替换、首步空值、成功最终文本及子 agent id、在失败/拒绝/令牌上限/中断时停止，以及启动下一项前取消。继续执行仅接受同一确切父 agent 的原生子 agent id 和匹配记录的配置；错误父 agent、错误配置、Pi/Paseo 句柄均拒绝。继续执行不重读配置文件，也不授予新工具。后续失败时，已完成链的 id 仍保留在工具结果中。
- [x] **步骤 3：运行红灯测试：** `pnpm exec vitest run packages/subagent/tool-subagent-profiles/tests/delegate.spec.ts packages/subagent/tool-subagent-profiles/tests/continuation.spec.ts`。
- [x] **步骤 4：实现** 基于 `startActivation()` 和 `sendMessage()` 的编排。分发前预检完整请求；并行启动逐项收集已完成状态，保留已启动兄弟任务的句柄。取消时 dispose（资源释放）确切的活动链子 agent，并等待清理；不声称进程丢失后可恢复链。在提示组装时渲染目录指导，调用时重新读取，使新定义可被发现。独立于工具可用性注册原生初始化处理器，保证 `spawn` 提供方重新加载时仍可恢复已存储子 agent。
- [x] **步骤 5：运行绿灯测试**、整个新包的针对性测试和任务 1/2 回归文件。新增真实 loader 用例调用实际注册工具，涵盖提供方卸载/重新加载及重复工具名拒绝。
- [x] **步骤 6：建立检查点**，仅在启动/继续执行测试与 transcript（文本记录）断言均通过后，认定面向用户的工具已完成本任务。

### 任务 6：录制 Session、SDK 投影与发布检查

**文件：** 新增手工编写、无密钥的场景 `snapshots/session/subagent-profiles/` 和 `snapshots/session/subagent-profiles-chain-failure/`，包含场景本地配置文件与补丁、规范的当前格式父/子 JSONL，以及可读提示/schema 对侧文件。新增 `packages/sdk/client/tests/subagent-profiles-projection.spec.ts` 及其所属 JSON 预期文件；新增 `python/sdk/tests/test_subagent_profiles_projection.py` 及其 JSON 预期文件。新增包本地真实提供方 e2e 与发布路径冒烟测试。更新 subagent 组 README、子系统双语文件、生成的目录/图，以及实现发布时已批准提案的生命周期。

- [x] **步骤 1：编写失败的预期输出**，涵盖配置发现/启动/完成/回退以及链失败。仅在当前无法重放这些行为时扩展所属快照控制器；不得绕过 `dsh`，不得为任意用户文本新增规范化，也不得覆盖已提交的旧 Session 代际文件。
- [x] **步骤 2：固定两个 SDK 的投影**，涵盖配置与路由记录及正常最终回答，参照现有翻译投影测试模式。两个 SDK 使用语义相同的预期记录，并保留各自原生原始事件交付。在实现或 fixture 支持尚未完成时先运行两个新增 SDK 针对性测试，确认红灯。
- [x] **步骤 3：执行场景**，运行 `pnpm run test:snapshot -- -t subagent-profiles`，并且仅通过显式快照工作流刷新手工编写的 fixture。运行 `pnpm exec vitest run packages/sdk/client/tests/subagent-profiles-projection.spec.ts` 和 `uv run --group test --project python/sdk pytest python/sdk/tests/test_subagent_profiles_projection.py`。新增有密钥条件的 e2e，使用配置的提供方路由且不记录密钥；凭据不可用时报告跳过。
- [x] **步骤 4：完成文档与生成**，以源文件为准：包/子系统约定、模型/令牌/KV Cache 影响、包策略、生成的工具/配置/持久化/目录引用以及双语记录。运行 `pnpm run gen-tsconfig-paths`、`package.json` 中相关生成器以及 `pnpm run verify-persistence-changes`。仅在行为已实现后将提案移动到 `implemented/feature/`，同步将两个语言版本改为规定的决定格式，并修复计划中指向提案的链接。
- [x] **步骤 5：执行最终验证：** 最终修订后尚未通过的针对性测试和 SDK/快照命令、先 `pnpm run build:artifacts` 后 `pnpm run build:check`、加载按需启用插件的构建后 `dsh` profile 冒烟测试、`pnpm run test:docs`、`pnpm run doc-sync`、相关 lint/workspace 检查，以及 `git diff --check`。默认不运行完整单元/覆盖率/平台套件。对照下述现有文档失败，不屏蔽它们。
- [x] **步骤 6：请求一位全新审查者审查完整变更**，通过回归测试处理范围内问题，然后报告实际命令与剩余失败/跳过项。未获授权且未遵循仓库适用的推送前工作流时，不提交、推送或合并。

## 现有验证结果

实现前，`pnpm run doc-sync` 报告 41 个检查通过、两个失败：`python/sdk/uv.lock:113` 中存在被禁止的提交引用，另有三个网站测试套件因 `No such built-in module: node:` 失败。本提案未修改这两处源文件。不得将这些结果与功能检查通过混为一谈，也不要在功能变更中顺带修复无关问题。

## 执行方式选择

六个任务共用子 agent 初始化、限制、快照与编排接口。建议在同一会话原生执行以降低额外开销，之后由一位全新审查者审查完整变更。如用户希望每项任务由独立实现者与审查者检查，也可选择 subagent 驱动执行。
