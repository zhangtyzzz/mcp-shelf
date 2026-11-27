# MCP Shelf

> [English](README.md) · **简体中文**

[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-007aff.svg)](LICENSE)
[![Zero Build](https://img.shields.io/badge/ui-zero--build%20vanilla%20ESM-5856d6)](#)

**一次配置 MCP，多个 Agent 共用。**

MCP Shelf 是一个轻量、零构建的本机 MCP 网关与可视化工作台。Codex、Claude Code、Google Antigravity 等客户端各自只需注册一个 `mcp-shelf` 服务，无需重复维护多份上游配置，也不会把几十个上游工具的庞大 JSON Schema 全量塞进 Agent 的初始上下文。

![MCP Shelf 工具目录](docs/catalog.png)

## 为什么选择 MCP Shelf？

| 痛点 | 传统做法（逐个直连 MCP） | MCP Shelf 方案 |
|---|---|---|
| 多客户端配置同步 | Codex / Claude / Antigravity 各自配一遍 | **一处配置、多端共用**，支持一键导入 JSON / TOML |
| 上下文 Token 膨胀 | 上百个工具的完整 Schema 全部塞进首屏 | **动态精简服务摘要 + 按需搜索**：首屏只暴露 3 个元工具与一行式服务清单 |
| 模型“盲目”不知有哪些工具 | 纯搜索网关需要用户手动提醒 | **自动注入服务摘要**（MCP `instructions` + 元工具描述），开局即感知能力边界 |
| 工具权限与安全 | 上游全量开放，难审计 | **默认禁止、逐个/批量白名单**，Ajv 参数强校验、调用记录与在线试调 |

## 核心工作流（3 个元工具）

| 元工具 | 用途 |
|---|---|
| `list_mcps` | 列出已启用的上游连接、状态、已开放工具数与名称预览（描述自动附带当前服务摘要）。 |
| `search_tool` | 关键词或精确 `tool_id` 检索已开放工具；**默认直接附带完整 `inputSchema` / `outputSchema`**（传 `include_schema: false` 可切回精简列表），支持中英文模糊匹配。 |
| `call_tool` | 用 `连接ID/工具名` 与 JSON 参数调用已开放工具，经本机 JSON Schema 校验后转发，完整保留上游结构化内容与错误标记。 |

当你在管理台新增连接、调整白名单或修改描述时，网关会通过 `/mcp-events` 触发标准的 MCP `notifications/tools/list_changed` 通知，让支持热刷新的客户端自动同步。

## 快速开始

需要 **Node.js 22+**（macOS / Linux）。

```sh
git clone https://github.com/zhangtyzzz/mcp-shelf.git MCP-Shelf
cd MCP-Shelf
npm ci
```

### 方式 A：正式启动本机网关（默认 `MCP_SHELF_MODE=local`）

```sh
npm start
```

打开 **http://127.0.0.1:8787**：
1. 在 **连接管理** 点击 **精选模板** 一键添加常用 MCP（如免费的 **Exa Search**、**Context7**、**Sequential Thinking**、**GitHub OAuth**），或点击 **导入配置** 粘贴已有 `mcpServers` JSON / Codex `config.toml`。
2. 点击 **读取工具** 完成握手发现，在 **工具目录** 逐个或批量开放工具，并可直接 **在线试调** 验证参数与返回。
3. 打开 **接入 Agent** 选择接入模式（**本机 stdio** / **OAuth 2.1** / **Streamable HTTP**）和对应客户端，一键复制配置。

也可以全局链接为命令行工具：

```sh
npm link
mcp-shelf          # 正式启动
mcp-shelf config   # 打印本机配置文件路径
```

如默认端口 `8787` 被占用，可通过环境变量指定端口或配置目录：

```sh
MCP_SHELF_PORT=8788 MCP_SHELF_HOME=~/.config/mcp-shelf-alt npm start
```

### 方式 B：Docker 远程自部署（跨设备访问 + Caddy / NPM 反代）

GitHub Actions 自动构建并推送多架构（`linux/amd64`, `linux/arm64`）镜像至 GHCR：
- `ghcr.io/zhangtyzzz/mcp-shelf:stable` / `:latest` — 稳定版镜像（`master` 分支与 `vX.Y.Z` Tag）
- `ghcr.io/zhangtyzzz/mcp-shelf:alpha` — 尝鲜版镜像（`alpha` 分支）

适合部署到你自己的 VPS / 服务器，前置于 Caddy、Nginx Proxy Manager 或 Cloudflare Tunnel 提供 HTTPS；部署后任意电脑的 Grok / Claude / Codex / Antigravity 都可以直连你的统一 MCP 网关：

```sh
# 1. 生成强管理密码（至少 12 位）
export MCP_SHELF_ADMIN_PASSWORD=$(openssl rand -base64 24)
export MCP_SHELF_PUBLIC_URL=https://mcp.example.com

# 2. 启动容器（默认拉取 :stable 镜像，仅监听宿主机 127.0.0.1:8787）
docker compose up -d
```

MCP Shelf 签给客户端的 OAuth 访问令牌默认有效 24 小时。可在 Docker 环境中设置 `MCP_SHELF_OAUTH_ACCESS_TTL_SECONDS`，调整新签发令牌的有效期。已签发的访问令牌按原时间到期。支持刷新令牌的 OAuth 客户端可以自动续期。刷新令牌每次使用都会轮换，有效期从首次授权起最长 30 天。

Caddy 反向代理示例见 [deploy/Caddyfile.example](deploy/Caddyfile.example)：

```caddy
mcp.example.com {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}
```

**远程模式安全机制：**
- 启用 `MCP_SHELF_MODE=remote`（或非回环绑定）时，**强制要求**至少 12 位的 `MCP_SHELF_ADMIN_PASSWORD`，未设置直接拒绝启动。
- 管理台使用 `scrypt` 校验密码 + 防爆破速率限制（15 分钟 10 次） + HMAC-SHA256 签名的 `HttpOnly; SameSite=Strict; Secure` Session Cookie。
- `/mcp` 端点始终使用独立的 64 位随机 `Authorization: Bearer <TOKEN>`，可在登录后的「接入 Agent」页按需查看、复制或一键轮换（轮换后旧设备立即失效）。

## 管理台功能

1. **连接管理**：管理本地 `stdio` 与远程 `Streamable HTTP` 连接，支持一键导入 JSON / Codex TOML、导出脱敏 JSON、单个/全部刷新，自动预警缺失的环境变量名并给出清晰错误诊断。
2. **工具目录**：实时搜索（按 `/` 快速聚焦）、按连接/授权状态筛选、查看输入/输出 Schema 与 SHA-256 指纹、覆盖工具描述、批量允许/撤销，以及内置 **在线试调**（自动生成参数骨架，`Cmd/Ctrl + Enter` 执行）。
3. **调用记录**：查看本机网关内存中最近 200 条 Agent 与试调活动流水（耗时、状态、拦截原因），支持 3 秒自动刷新、按来源筛选与清空，不落盘敏感参数。
4. **元工具描述**：实时预览自动注入给 Agent 的精简服务摘要与目录指纹，自定义三个元工具文案或一键恢复默认。
5. **接入 Agent**：展示当前实例端口与配置文件路径，一键复制各客户端配置。

## 客户端接入矩阵

| Agent | 接入方式 | 验证状态 |
|---|---|---|
| **Grok Build** | `grok mcp add mcp_shelf -- <node> <cli> stdio` | macOS 本地实测注册与 `grok mcp doctor` 握手健康通过（protocol 2025-11-25） |
| **Codex** | `[mcp_servers.mcp_shelf]` + stdio Bridge | macOS 本地实测通过工具发现与 `--roundtrip` 端到端调用往返 |
| **Claude Code** | `claude mcp add --transport stdio …` | CLI 2.1.332 实测注册与 Connected 连接 |
| **Google Antigravity** | Manage MCP Servers → 原始配置 `mcpServers` | 按官方文档格式生成 |
| **任意 Streamable HTTP 客户端** | `POST http://127.0.0.1:8787/mcp` + `Authorization: Bearer <TOKEN>` | 官方 MCP SDK 端到端实测通过 |

官方文档参考：[Codex MCP](https://developers.openai.com/codex/mcp) · [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [Google Antigravity MCP](https://antigravity.google/docs/ide-mcp)

## 安全与边界

- **本地凭据隔离**：默认配置 `~/.config/mcp-shelf/config.json`（权限 `0600`），Bearer Token 由网关生成并仅保存在本机文件，绝不在管理台界面或导出 JSON 中暴露。
- **不存明文 Secret**：上游凭据仅通过环境变量名（`envKeys` / `bearerEnv`）引用，导入外部配置时自动剥离明文值。
- **四重本机管理台防护**：仅监听 `127.0.0.1`，严格校验 `Host`、`Origin`、`Sec-Fetch-Site` 与 `X-Shelf-CSRF`。请勿将管理台暴露至公网或共享网络。
- **最小权限原则**：新发现工具默认禁止；更改上游命令、URL 或凭据变量名会自动重置旧授权。`stdio` 进程继承当前系统用户权限，**请仅添加可信服务**。
- **调用约束**：输入请求上限 1 MiB，上游回包上限 512 KB，发现超时 12s，调用超时 30s，不自动重试写操作。

更多架构权衡与边界见 [设计说明](docs/design.zh-CN.md) 与 [验收记录](docs/verification.zh-CN.md)。

## 开发与测试

```sh
npm test                          # 全部协议、权限、导入导出、搜索与安全集成测试
npm run test:ui                   # Playwright 浏览器 E2E（自动探测本机 Chrome/Chromium）
node test/codex.mjs --roundtrip   # Codex CLI 真实发现与工具调用往返（无需 API Key）
node test/grok.mjs                # Grok Build CLI 注册与 doctor 健康检查（需已安装 grok）
node test/claude.mjs              # Claude Code CLI 连接验证（需已安装 claude）
```

## License

[MIT](LICENSE)
