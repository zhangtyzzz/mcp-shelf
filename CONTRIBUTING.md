# Contributing to MCP Shelf

欢迎提交 Issue 和 Pull Request！

## 开发环境

- Node.js >= 22（零构建、纯 ESM，无需打包工具）
- 可选：本机 Chrome / Chromium（用于运行 Playwright UI 端到端测试）

```sh
npm ci
npm run demo
```

## 目录结构

```text
src/
  main.mjs      # CLI 入口 (serve / demo / stdio / config) 与对外导出
  server.mjs    # 本机 HTTP 网关、安全中间件、管理台 API、/mcp 与 /mcp-events
  catalog.mjs   # 上游连接池、目录缓存、搜索打分、Ajv 校验、调用日志与变更通知
  config.mjs    # 0600 原子配置持久化、字段校验、JSON/TOML 导入解析
ui/
  index.html    # Web 工作台入口
  style.css     # macOS 26 (Liquid Glass) 风格样式
  app.js        # 零依赖原生前端应用
  icon.svg      # 应用图标
test/
  gateway.test.mjs  # 核心协议、权限、导入导出、搜索与安全集成测试
  ui.mjs            # Playwright 浏览器端到端测试（桌面 + 390px 移动端）
  codex.mjs         # Codex CLI 真实发现与 --roundtrip 往返测试
  claude.mjs        # Claude Code CLI 真实注册与连接测试
```

## 提交前检查

请确保以下命令在本地全部通过：

```sh
npm test
npm run test:ui
```

如涉及协议或桥接改动且本机安装了 Codex / Claude CLI，建议补充验证：

```sh
node test/codex.mjs --roundtrip
node test/claude.mjs
```

## 安全原则

- 管理台仅绑定 `127.0.0.1`，禁止移除 Host / Origin / Sec-Fetch-Site / CSRF 校验。
- 上游凭据只通过环境变量名引用，禁止将明文 Secret 写入 `config.json` 或导出文件。
- 新发现的上游工具默认不在白名单中；修改上游命令、URL 或凭据变量名必须重置旧授权。
