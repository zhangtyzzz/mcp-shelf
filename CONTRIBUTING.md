# Contributing to MCP Shelf

Issues and pull requests are welcome!

## Development Setup

- **Node.js >= 22** (zero-build pure ESM)
- Optional: local Chrome or Chromium for Playwright UI E2E tests

```sh
npm ci
npm run demo
```

## Project Layout

```text
src/
  main.mjs      # CLI entry (serve / demo / stdio / config) & public exports
  server.mjs    # HTTP gateway, local/remote auth, admin API, /mcp & /mcp-events
  catalog.mjs   # Upstream pool, 60s cache, search, Ajv validation, logs & events
  config.mjs    # 0600 atomic config storage, validation, JSON/TOML importer
ui/
  index.html    # Web workbench shell
  style.css     # macOS 26 Liquid Glass styling (Starlight Warm Stone × Nordic Slate)
  app.js        # Zero-dependency SPA
  i18n.js       # Lightweight i18n loader & locale registry
  locales/      # Translation dictionaries (en.js, zh-CN.js, ...)
  icon.svg      # App icon
test/
  gateway.test.mjs  # Core protocol, allowlist, remote auth & security tests
  ui.mjs            # Playwright E2E (desktop/mobile, i18n, playground, live MCP)
  grok.mjs          # Grok Build CLI registration & doctor test
  codex.mjs         # Codex CLI discovery & --roundtrip test
  claude.mjs        # Claude Code CLI registration test
```

## Branching, PRs & Release Channels

MCP Shelf uses a clean two-channel release model backed by GitHub Actions + GHCR (`ghcr.io/zhangtyzzz/mcp-shelf`):

| Branch / Tag | Purpose | Automated Docker Image Tags (`linux/amd64`, `linux/arm64`) |
|---|---|---|
| **`alpha`** | Active integration branch — **target all feature/fix PRs here** | `:alpha`, `:alpha-<sha>` |
| **`stable`** | Production-ready branch (promoted from `alpha` after verification) | `:stable`, `:latest`, `:stable-<sha>` |
| **`vX.Y.Z`** | Stable release tag (e.g. `v0.6.0`) | `:0.6.0`, `:0.6`, `:0`, `:stable`, `:latest` |
| **`vX.Y.Z-alpha.N`** | Pre-release tag (e.g. `v0.7.0-alpha.1`) | `:0.7.0-alpha.1`, `:alpha` (never touches `:latest`) |
| **Pull Requests** | CI runs protocol tests, Playwright UI E2E, and Docker build check | Build-only (not pushed) |

### Typical Iteration Flow

1. Fork & branch from `alpha`, implement changes, and open a PR targeting `alpha`.
2. After CI passes and the PR merges into `alpha`, GHCR publishes `:alpha` automatically for dogfooding.
3. When ready to release, fast-forward/merge `alpha` → `stable` (and sync `master`), bump `package.json` + `CHANGELOG.md`, and push a `vX.Y.Z` tag.

## Adding a New Language (i18n)

1. Copy [ui/locales/en.js](ui/locales/en.js) to `ui/locales/<code>.js` (e.g. `ja.js`, `ko.js`, `de.js`, `fr.js`) and translate the values.
2. Add `{ code: '<code>', label: '<Native Name>' }` to `LOCALES` in [ui/i18n.js](ui/i18n.js).
3. Restart the server — `src/server.mjs` automatically discovers and serves all files under `ui/locales/*.js`.

## Pre-PR Checklist

```sh
npm test
npm run test:ui
```

If you modified MCP protocol or bridge behavior and have Codex / Grok / Claude CLIs installed:

```sh
node test/codex.mjs --roundtrip
node test/grok.mjs
node test/claude.mjs
```

## Security Invariants

- Never weaken `Host`, `Origin`, `Sec-Fetch-Site`, CSRF, or remote-mode session checks.
- Never store plaintext upstream secrets in `config.json` or exported JSON; always reference by env var name.
- Newly discovered tools must remain denied by default; changing upstream command, URL, or credential env names must reset approvals.
