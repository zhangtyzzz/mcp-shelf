# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-11-27

### Added
- **本地 / 远程双模式（`MCP_SHELF_MODE=local|remote`）**：远程模式强制要求 `MCP_SHELF_ADMIN_PASSWORD`（≥12 位），提供 `scrypt` 校验、防爆破限流、HMAC-SHA256 签名的 `HttpOnly; SameSite=Strict; Secure` Session Cookie、管理台玻璃登录页、远端 `https://.../mcp` 接入片段与 Bearer Token 按需查看/一键轮换。
- **Docker 与反代部署套件**：新增 `Dockerfile`（Node 22 slim 非 root 运行 + `/healthz` 健康检查）、`.dockerignore`、`docker-compose.yml` 与 `deploy/Caddyfile.example`。
- **Grok Build 原生集成**：管理台「接入 Agent」页新增 Grok Build 一键接入命令（本机 stdio 与远端 HTTP），新增 `test/grok.mjs` 自动化测试。
- **星光暖白 × 黛蓝釉色（Starlight Warm Stone × Nordic Slate）视觉打磨**：收敛高饱和色彩，提升 macOS 26 Liquid Glass 质感与长期阅读舒适度。

## [0.3.0] - 2026-11-27

### Added
- **动态服务摘要注入（Progressive Visibility）**：自动将当前已启用且含开放工具的上游连接以精简摘要（`- <id> (<N> tools): <description>`）注入 MCP `initialize` `instructions` 与 `list_mcps` / `search_tool` 描述，Agent 开局即可直观感知能力边界，同时避免全量工具 Schema 撑爆上下文。
- **一步搜索即得 Schema**：`search_tool` 默认直接随命中结果返回完整 `inputSchema` / `outputSchema`（传 `include_schema: false` 可切回精简列表），减少一轮工具调用往返。
- **热更新通知（`notifications/tools/list_changed`）**：新增 Bearer 鉴权的 `/mcp-events` SSE 事件通道与目录指纹检测；管理台修改连接、白名单或描述后，stdio Bridge 实时向客户端推送 `tools/list_changed`。
- **macOS 26 (Liquid Glass) 视觉设计**：重塑 Web 工作台为悬浮毛玻璃侧边栏、Apple System 语义色与胶囊控件风格，更新应用图标与元工具页「实时服务摘要预览」。
- **开源发布就绪**：补充 `LICENSE` (MIT)、`CONTRIBUTING.md`、`CHANGELOG.md`，支持 `mcp-shelf` CLI `bin` 入口。

## [0.2.0] - 2026-11-27

### Added
- 模块化后端拆分（`config.mjs`、`catalog.mjs`、`server.mjs`、`main.mjs`）。
- 一键导入/导出配置（支持 Claude / Antigravity / Cursor `mcpServers` JSON 与 Codex `config.toml`，绝不保存明文 Secret）。
- 工具在线试调（Playground，自动生成 Schema 骨架、支持 `Cmd/Ctrl + Enter` 快捷键）。
- 内存调用记录视图（`/api/logs`，支持自动刷新、按来源筛选与清空）。
- CJK 二元切词搜索兜底、Schema SHA-256 指纹、批量刷新/批量授权、`/healthz` 探活与缺失环境变量名预警。

### Fixed
- 修复 `server.requestTimeout`（原 20s）低于上游 `callTool` 超时（30s）的问题，调整为 65s。
- 改进上游连接失败与端口占用（`EADDRINUSE`）诊断提示。

## [0.1.0] - 2026-11-27

- 初始版本：本机 MCP 网关、三元工具、白名单控制、stdio / Streamable HTTP 上游支持与基础管理台。
