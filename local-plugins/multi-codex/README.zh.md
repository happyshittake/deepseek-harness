# @local/multi-codex

[English](README.md) | 中文

pi 扩展 `~/.pi/agent/extensions/codex-multi.ts` 的本地 DeepSeek Harness 移植版本：通过提供方路由 `multi-codex/<model>` 使用多个 ChatGPT Codex OAuth 账号。

## 安装

此独立本地包位于 DSH 工作区包之外，随附配置不会启用它。在此目录运行 `pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts` 安装依赖，再通过 Harness Plugin Manager（`install_bundle`）安装该目录的绝对路径。仓库不包含凭据或账号状态。

## 能力

- 使用已安装 pi-ai 的 Codex 模型目录，在模型选择器中注册 **OpenAI Codex (multi)**。实际模型访问权限取决于所选账号。
- 新对话选择分配数量最少的健康账号，并保持账号不变以复用缓存。在输出开始前发生限流或认证失败时，记录共享冷却时间并选择其他账号。
- 账号、OAuth 令牌和路由预留共享 pi agent（智能体）目录（`$PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`），包括 `auth.json.lock` 和 `multi-codex-routing.json.lock`。
- 令牌刷新使用共享认证锁，复用其他进程已刷新的凭据，避免重复刷新会轮换的令牌。
- 提供用于生成和编辑 PNG 的 `multi_codex_image`，以及用于管理账号的 `/multi-codex-auth`。

## 命令

```text
/multi-codex-auth list
/multi-codex-auth use <label|default>
/multi-codex-auth login <label> [device]
/multi-codex-auth cancel <label>
```

`list` 显示认证状态、冷却时间、租约和待完成登录的操作说明。`use` 为会话选择账号。`login` 启动后台浏览器 OAuth 或设备码登录；`cancel` 中止待完成的登录。

浏览器登录通过本机回环端口 1455 接收回调，与 Codex CLI（命令行界面）共享该端口。如果端口被占用，可通过 pi 登录；由于两者读取同一认证存储，该账号也会在此出现。

## 注意事项

- 插件运行期间，每次请求和每分钟定时任务都会续订租约。进程停止后，剩余租约会在五分钟内过期。
- 图像工具以会话工作目录为基准解析输出路径，并拒绝覆盖已有文件。
- 直接调用 pi-ai 提供方前会规范化上下文，确保初始系统提示词和工具声明传递到提供方。
