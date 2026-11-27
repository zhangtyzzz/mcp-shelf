# Changelog

All notable changes to this project will be documented in this file.

## [0.8.4] - 2026-11-28

### Fixed
- **Upstream OAuth renewal**: Keep background Streamable HTTP connections on the OAuth authorization-code flow so stored refresh tokens renew expired access tokens. Concurrent calls share a refresh request for the same credentials. Transient failures preserve credentials, and missing or revoked credentials prompt for sign-in.

## [0.8.3] - 2026-11-27

### Fixed
- **Browser OAuth authorization**: Same-origin consent forms send the expected Origin, including after a password retry. Browser approvals continue to the registered client callback while enforcing the existing CSP and cross-origin request checks.

## [0.8.2] - 2026-11-27

### Security
- **HTML Escaping & CSP Compliance**: Escaped `/api/oauth/callback` HTML output and removed inline `style` attributes.
- **Strict OAuth 2.1 Redirect URI Validation**: Blocked non-loopback `http://` and unsafe custom schemes (`blob:`, `ftp:`, `ws:`, `wss:`, `about:`) in Dynamic Client Registration (`/oauth/register`).
- **Auth & Rate-Limit Hardening**: Switched password verification to async `scrypt` with length caps; gated `X-Forwarded-*` trust behind explicit `MCP_SHELF_TRUST_PROXY=true`; prevented rate-limit table global wipes; added server-side session revocation on `/api/auth/logout`; added HSTS header on HTTPS requests.
- **OAuth Server Hardening**: Rate-limited `/oauth/register`, bounded pending `forms`/`codes` and PKCE/state lengths, preserved clients with active tokens during eviction, moved store to `oauth/_server.json` (avoiding collision with upstream `id: "server"`), hid Access Profile names from unauthenticated `/oauth/authorize` pages in remote mode, and revoked scoped OAuth tokens when rotating master/profile tokens or deleting profiles.
- **Secret Isolation & Container Hardening**: Blocked `MCP_SHELF_*`, `NODE_OPTIONS`, and dynamic linker env vars from `envKeys`/`bearerEnv`; validated upstream `authorizeUrl` schemes (`https:` or loopback `http:`); kept `/app` read-only to `node` in `Dockerfile`; added `cap_drop: [ALL]` and `no-new-privileges:true` to `docker-compose.yml`; fixed `TaskManager.prune()` and capped concurrent async tasks.

## [0.8.1] - 2026-11-27

### Added
- **Persistent OAuth 2.1 Server Store**: Dynamically registered OAuth clients and issued access tokens are now persisted atomically to `<MCP_SHELF_HOME>/oauth/server.json` (`0600`) with tokens stored strictly as SHA-256 hashes (never plaintext), so connected OAuth MCP clients stay authenticated across container and server restarts.

### Fixed
- **Reverse-Proxy Origin & Host Handling**: Remote mode now accepts `MCP_SHELF_PUBLIC_URL`'s origin and valid `X-Forwarded-Host` headers when reverse proxies (Caddy, Nginx, Cloudflare Tunnel, Instabox) rewrite `Host` to loopback (`127.0.0.1`).
- **Docker Compose Default**: Left `MCP_SHELF_PUBLIC_URL` empty by default in `docker-compose.yml` to prevent unintended `403 Host not allowed` or `Secure` cookie mismatches during plain-HTTP/IP testing.

## [0.8.0] - 2026-11-27

### Added
- **Built-in OAuth 2.1 + PKCE Authorization Server** (`src/oauth_server.mjs`): Implements RFC 9728 Protected Resource Metadata, RFC 8414 Authorization Server Metadata, RFC 7591 Dynamic Client Registration, and S256 PKCE authorization with optional Access Profile scope selection — allowing OAuth-capable MCP clients to connect without copying Bearer tokens manually.
- **Legacy SSE Transport Compatibility**: Added `GET /sse` (`/sse/<profile_id>`) + `POST /messages` using official SDK `SSEServerTransport` with per-session Bearer/OAuth verification and live `tools/list_changed` notifications.
- **Expanded Modular Test Suite**: Added `test/transports.test.mjs` covering full OAuth 2.1 + PKCE server flows, Legacy SSE end-to-end calls, and profile isolation.

## [0.7.0] - 2026-11-27

### Added
- **Upstream OAuth 2.1 + PKCE Support** (`src/oauth.mjs`): Full `OAuthClientProvider` implementation with `0600` per-server token persistence, browser authorization redirect & `/api/oauth/callback` handling, and one-click Sign In / Sign Out controls in Connections.
- **MCP 2025-11-25 Async Tasks & Metadata** (`src/tasks.mjs`): Native `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel` handlers for task-augmented `call_tool` calls (up to 5-minute background execution with cancellation), plus sanitized upstream `title` & `icons` rendering.
- **Access Profiles (Multi-Machine / Multi-VPS / Multi-Project Scopes)**: Create dedicated scoped Bearer tokens (`/mcp` or `/mcp/<profile_id>`) that only activate selected upstream MCP connections, with full UI management in Connect Agents.
- **Schema Drift Lock**: Auto-locks `schemaHash` upon tool approval; detects upstream parameter drift, flags tools with `Schema Changed` + one-click `Re-approve`, and blocks drifted invocations when strict drift lock is enabled.
- **Curated Classic MCP Templates**: Built-in one-click templates in Connections including **Exa Search (Free Hosted)**, **Context7 Docs**, **Sequential Thinking**, **Local Filesystem**, **Playwright Browser**, and **GitHub (Remote OAuth)**.

## [0.6.0] - 2026-11-27

### Added
- **Context & Scale Budgets**:
  - Bounded `serverReminder` character budget (`1400` chars in `initialize.instructions`, `480` chars in meta-tool descriptions with automatic compact fallback) so 40+ servers never exceed provider description limits.
  - Per-response `search_tool` schema byte budget (`16 KB`): high-relevance matches include full `inputSchema`, overflow matches gracefully degrade to compact metadata + `required_params`.
  - Upstream failure exponential backoff circuit breaker (`30s → 60s → 120s → 300s`) and stale-while-revalidate catalog refresh so dead upstreams never stall searches.
- **Configurable Activity Log & Redacted Payloads**:
  - Persistent `settings` (`logLimit`: `0 | 50 | 200 | 500 | 1000`, `logDetails`: boolean, `idleMinutes`: `0 | 5 | 10 | 30 | 60`) configurable right from the Activity view.
  - Optional detail recording automatically redacts sensitive keys (`token`, `secret`, `password`, `apiKey`, `authorization`, `cookie`) and lets you replay any `call_tool` directly in the Tool Catalog playground.
- **Stdio Idle Hibernation**: Idle `stdio` upstream child processes automatically sleep after `idleMinutes` while preserving their discovered tool catalog in memory, waking on demand when called.
- **Automated Multi-Arch Docker CI/CD & Release Channels**: Added `.github/workflows/docker.yml` publishing `linux/amd64` + `linux/arm64` images to `ghcr.io/zhangtyzzz/mcp-shelf` across `:alpha`, `:stable`, `:latest`, and SemVer tags, plus PR/Issue templates.

### Fixed
- Removed remaining inline `style` attributes in `ui/app.js` for zero CSP console warnings under `style-src 'self'`.

## [0.5.0] - 2026-11-27

### Added
- **Extensible Internationalization (i18n)**: Zero-dependency i18n framework (`ui/i18n.js` + `ui/locales/*.js`) defaulting to English (`en`) with built-in Simplified Chinese (`zh-CN`), live language switcher in the top bar, `localStorage` persistence, and auto-discovered locale packs on the server.
- **Bilingual Documentation**: English default `README.md`, full Chinese `README.zh-CN.md`, and English `CONTRIBUTING.md` with translation contributor guide.
- **Generic Discovery Improvements**: Server summary injected across all three meta-tool descriptions (`list_mcps`, `search_tool`, `call_tool`) plus a generic `how_to_call` hint in `search_tool` results.

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
