# v0.3.0 验收范围

- **macOS 本地环境，Node v24.1.0**：
  - `npm test`（5 个集成测试全部通过）：HTTP 和 stdio 接入、三个元工具、Grok-Build 风格动态服务摘要注入（MCP `instructions` 与 `tools/list` 描述）、`search_tool` 默认返回完整 Schema 与 `include_schema=false` 精简模式、`/mcp-events` SSE 鉴权与 `tools_changed` 推送、同名区分、输入校验、白名单、配置重启持久化、上游 HTTP 认证/分页、结构化结果保留、请求防护、JSON/TOML 配置导入与脱敏导出、批量刷新、工具在线试调、内存调用记录与清空、缺失环境变量名预警、CJK 二元搜索、Schema 指纹、`/healthz` 及上游连接诊断信息。
  - `npm run test:ui`（Playwright + 本机 Chrome 端到端通过，无 `pageerror`）：Apple macOS 26 (Liquid Glass) 桌面/移动端（390×844 无横向溢出）布局、添加与停用连接、导入配置预览与确认、允许工具、搜索、覆盖描述、在线试调、调用记录查看与清空、元工具描述与实时摘要验证、接入配置以及真实 MCP 客户端调用验证。
  - `node test/codex.mjs --roundtrip`（本机 Codex CLI 实测通过）：通过本机 stdio Bridge 发现精确 3 个元工具，并完成 `search_tool` 与 `call_tool`（`demo/echo`）完整调用往返（不消耗模型推理）。
- **其他环境**：
  - Claude Code 2.1.332：v0.1.0 已在 Linux 环境实测注册 stdio 和 `claude mcp list` 报告 Connected（当前 macOS 环境未安装 `claude` CLI）。
  - Google Antigravity：配置格式对照官方文档，未运行该客户端。
