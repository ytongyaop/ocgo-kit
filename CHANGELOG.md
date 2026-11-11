# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
格式参照 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，按 Added / Changed / Fixed 分类记录。

## [Unreleased]

## [0.1.0] - 2026-11-11

### Added

- 首次公开：7 个角色分工（build / plan / general / explore / advisor / final / writer）、6 阶段 9 个流程、门禁四条硬规则。
- `config/AGENTS.md`：脱敏模板，占位符统一为 `{{USER}}` / `{{CFG_ROOT}}` / `{{WORK_ROOT}}` / `{{KNOWLEDGE_ROOT}}`。
- `config/opencode.json.example`：可复制的完整配置，含四个内联角色与权限、MCP、记忆开关。
- `config/agents/`：advisor / final / writer 三个独立角色定义。
- `config/workflows/`：需求、架构、开发、测试、发布、观察、委派、继续、知识库，共 9 个流程。
- `PROMPT.md`：给 AI 的安装作业单，含前置检查、备份、只增不覆盖、合并结果确认。
- `scripts/doctor.mjs`：12 项配置体检，FAIL 时退出码 1。
- `scripts/memory-lint.mjs`：11 条记忆库规则体检，由 PowerShell 版移植。
- `scripts/install.mjs`：把 `config/` 装进本机，默认 dry-run，不碰 `opencode.json`。
- `scripts/sync.ps1`：维护者用的防漂移校验（Windows PowerShell）。
- `docs/00~09`：设计取舍、安装、额度分配、角色分工、记忆模式、知识库接入、网络环境、自查手册、踩坑记录、推荐技能。
- `examples/memory.example.json`：虚构记忆库示例，通过 `memory-lint` 校验。

### Changed

- 流程体系从早期的 8 个流程重构为六阶段 9 个流程。
- 移除依赖私有离线代理的 WorkBuddy 流程，不纳入公开版本。

### Fixed

- 修正记忆文件路径说明与配置不一致的问题（只认 `MEMORY_FILE_PATH` 一处）。
- 修正示例配置里把 `<>` 尖括号写进路径类字段的问题。
