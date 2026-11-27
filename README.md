# MCP Shelf

> **English** · [简体中文](README.zh-CN.md)

[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-2e5073.svg)](LICENSE)
[![Zero Build](https://img.shields.io/badge/ui-zero--build%20ESM-5856d6)](#)
[![i18n](https://img.shields.io/badge/i18n-en%20%7C%20zh--CN-2b644d)](#internationalization)

**Configure MCP servers once. Share them across every AI agent — locally or self-hosted.**

MCP Shelf is a lightweight, zero-build Model Context Protocol (MCP) gateway and web workbench. Instead of duplicating upstream MCP configs across Grok Build, Codex, Claude Code, and Google Antigravity — or bloating every session with dozens of massive JSON tool schemas — each client registers **only MCP Shelf**.

![MCP Shelf Tool Catalog](docs/catalog.png)

## Why MCP Shelf?

| Problem | Traditional Setup (Direct MCPs) | MCP Shelf |
|---|---|---|
| Multi-agent config sprawl | Maintain separate configs for Grok, Codex, Claude, Antigravity | **Configure once, share everywhere** — with one-click JSON / Codex TOML import |
| Context window bloat | All upstream JSON schemas dumped into every turn | **Compact server summary + on-demand search** via 3 gateway meta-tools |
| "Blind" search gateways | Models don't know which servers exist unless prompted | **Auto-injected server summary** in MCP `initialize.instructions` and meta-tool descriptions |
| Security & governance | Upstream tools exposed all-or-nothing | **Deny-by-default allowlist**, Ajv schema validation, live playground, and activity log |
| Cross-device access | Tied to one machine | **Local & Remote modes** — run on loopback or deploy via Docker behind Caddy / NPM |

## How It Works (3 Meta-Tools)

| Meta-Tool | Purpose |
|---|---|
| `list_mcps` | Lists enabled upstream connections, status, approved tool counts, and previews. |
| `search_tool` | Searches approved upstream tools by keyword or exact `tool_id` (with CJK bigram fallback). Returns full `inputSchema` / `outputSchema` and a `how_to_call` hint by default (`include_schema: false` for compact names). |
| `call_tool` | Proxy-invokes one approved upstream tool by `server/tool` ID after local JSON Schema validation, preserving structured content and upstream error flags. |

Whenever you add connections, update approvals, or edit descriptions in the workbench, MCP Shelf notifies connected clients via standard MCP `notifications/tools/list_changed`.

## Quick Start

Requires **Node.js 22+** (macOS / Linux).

```sh
git clone https://github.com/zhangtyzzz/mcp-shelf.git MCP-Shelf
cd MCP-Shelf
npm ci
```

### Option A: Offline Demo (No External Credentials Needed)

```sh
npm run demo
```

Opens an isolated temporary instance on **http://127.0.0.1:8787** with pre-approved `demo/echo` and `demo/add` tools.

### Option B: Local Gateway (Default `MCP_SHELF_MODE=local`)

```sh
npm start
```

Open **http://127.0.0.1:8787**:
1. In **Connections**, add local `stdio` or remote `Streamable HTTP` servers — or click **Import** to paste existing `mcpServers` JSON or Codex `config.toml`.
2. Click **Fetch Tools**, review and approve tools in **Tool Catalog**, and test them directly in the built-in **Playground**.
3. Open **Connect Agents** to copy ready-to-use snippets for Grok Build, Codex, Claude Code, Google Antigravity, or Streamable HTTP.

Optional global CLI link:

```sh
npm link
mcp-shelf          # Start local gateway
mcp-shelf demo     # Start offline demo
mcp-shelf config   # Print local config.json path
```

Custom port or config directory:

```sh
MCP_SHELF_PORT=8788 MCP_SHELF_HOME=~/.config/mcp-shelf-alt npm start
```

### Option C: Self-Hosted Docker Deployment (`MCP_SHELF_MODE=remote`)

Prebuilt multi-arch (`linux/amd64`, `linux/arm64`) images are automatically published to GHCR:
- `ghcr.io/zhangtyzzz/mcp-shelf:stable` / `:latest` — stable releases (`master` branch & `vX.Y.Z` tags)
- `ghcr.io/zhangtyzzz/mcp-shelf:alpha` — preview builds (`alpha` branch)

Deploy MCP Shelf on your VPS behind **Caddy**, **Nginx Proxy Manager**, or **Cloudflare Tunnel** so all your devices share one authenticated MCP gateway:

```sh
export MCP_SHELF_ADMIN_PASSWORD=$(openssl rand -base64 24)
export MCP_SHELF_PUBLIC_URL=https://mcp.example.com

docker compose up -d
```

See [deploy/Caddyfile.example](deploy/Caddyfile.example) for a 5-line automatic HTTPS reverse proxy config.

**Remote Mode Security:**
- Refuses to start unless `MCP_SHELF_ADMIN_PASSWORD` is at least 12 characters.
- Admin workbench protected by `scrypt` password verification, per-IP brute-force rate limiting (10 attempts / 15 min), and HMAC-SHA256 signed `HttpOnly; SameSite=Strict; Secure` session cookies.
- `/mcp` endpoint uses an independent 64-hex-char `Authorization: Bearer <TOKEN>` that can be revealed, copied, or rotated anytime from **Connect Agents**.

## Client Matrix

| Client | Transport | Verification |
|---|---|---|
| **Grok Build** | `grok mcp add mcp_shelf -- <node> <cli> stdio` (or remote HTTP) | Verified on macOS (`grok mcp doctor` + live end-to-end tool calls) |
| **Codex** | `[mcp_servers.mcp_shelf]` + stdio Bridge | Verified on macOS (discovery + `--roundtrip` execution) |
| **Claude Code** | `claude mcp add --transport stdio …` (or remote HTTP) | Verified registration & Connected status |
| **Google Antigravity** | Manage MCP Servers → Raw Config `mcpServers` | Matches official config format |
| **Any Streamable HTTP Client** | `POST /mcp` + `Authorization: Bearer <TOKEN>` | Verified end-to-end via official MCP SDK |

## Internationalization

The web workbench ships with built-in, zero-dependency i18n (**English** default + **简体中文**), switchable live from the top bar. Adding another language only requires dropping a single dictionary file in `ui/locales/<code>.js` and registering it in [ui/i18n.js](ui/i18n.js) — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Security Boundaries

- Config stored at `~/.config/mcp-shelf/config.json` (mode `0600`). Secrets are referenced by environment variable name only (`envKeys` / `bearerEnv`) and never written to disk or exported.
- Local mode binds strictly to `127.0.0.1` with `Host`, `Origin`, `Sec-Fetch-Site`, and CSRF checks.
- Newly discovered tools are blocked by default; changing upstream command, URL, or credential env names automatically resets approvals.
- Request body limit 1 MiB, upstream output limit 512 KB, discovery timeout 12s, tool call timeout 30s, no automatic write retries.

## Testing

```sh
npm test                          # Protocol, allowlist, import/export, remote auth & security tests
npm run test:ui                   # Playwright E2E (desktop/mobile, i18n, playground, live MCP)
node test/codex.mjs --roundtrip   # Codex CLI discovery & tool call roundtrip
node test/grok.mjs                # Grok Build CLI registration & doctor check
node test/claude.mjs              # Claude Code CLI connectivity check
```

## License

[MIT](LICENSE)
