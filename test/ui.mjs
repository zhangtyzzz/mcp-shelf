import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { launch, httpClient } from '../src/main.mjs';

function detectBrowser() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-ui-'));
const app = await launch({ dir, port: 0 });
const c = new Client({ name: 'ui-test', version: '1' });
let browser;

try {
  browser = await chromium.launch({ headless: true, executablePath: detectBrowser() });
  const p = await browser.newPage({ viewport: { width: 1360, height: 880 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  await p.goto(app.url);
  await p.getByRole('heading', { name: '连接管理', exact: true }).waitFor();
  await p.getByRole('button', { name: '加载离线示例' }).click();
  await p.getByText('已连接', { exact: true }).waitFor();

  // Tools view: allow, edit description (details stays open across save), search, and playground test
  await p.getByRole('button', { name: /工具目录/ }).click();
  const echo = p.locator('.tool').filter({ has: p.getByRole('heading', { name: 'demo/echo', exact: true }) });
  await echo.getByRole('button', { name: '允许', exact: true }).click();
  await echo.getByText('Agent 可调用', { exact: true }).waitFor();
  await echo.getByText('参数和描述', { exact: true }).click();
  await echo.getByRole('textbox', { name: '覆盖 demo/echo 的描述' }).fill('回显 <img src=x onerror=alert(1)>');
  await echo.getByRole('button', { name: '保存描述', exact: true }).click();
  await echo.getByText('回显 <img src=x onerror=alert(1)>', { exact: true }).waitFor();
  assert.equal(await echo.locator('img').count(), 0);

  await p.getByRole('searchbox', { name: '搜索工具' }).fill('回显');
  assert.equal(await p.locator('.tool').count(), 1);
  // Details remains open after save/filter
  await echo.getByRole('textbox', { name: '覆盖 demo/echo 的描述' }).fill('回显指定文字，用于验证端到端的调用。');
  await echo.getByRole('button', { name: '保存描述', exact: true }).click();
  await echo.getByText('回显指定文字，用于验证端到端的调用。', { exact: true }).waitFor();

  // Playground test call
  await echo.getByRole('textbox', { name: '试调 demo/echo 的 JSON 参数' }).fill('{"text":"UI Playground"}');
  await echo.getByRole('button', { name: '试调工具', exact: true }).click();
  await echo.getByText('试调成功', { exact: true }).waitFor();
  await echo.getByText('UI Playground').waitFor();

  await p.getByRole('searchbox', { name: '搜索工具' }).fill('');
  if (process.env.SHELF_SHOT) await p.screenshot({ path: process.env.SHELF_SHOT, fullPage: true });

  // Meta-tool descriptions
  await p.getByRole('button', { name: /元工具描述/ }).click();
  await p.getByRole('textbox', { name: 'search_tool', exact: true }).fill('新的搜索描述');
  await p.getByRole('button', { name: '保存元工具描述' }).click();
  await p.getByText('元工具描述已保存', { exact: true }).waitFor();

  // Live MCP client verification
  await c.connect(httpClient(app.url + '/mcp', { Authorization: 'Bearer ' + app.config.get().token }));
  const listedTools = await c.listTools();
  assert.ok(listedTools.tools[1].description.startsWith('新的搜索描述'));
  assert.match(listedTools.tools[1].description, /Connected MCP servers:\n- demo \(1 tool\):/);
  assert.deepEqual(
    (await c.callTool({ name: 'call_tool', arguments: { tool_id: 'demo/echo', arguments: { text: 'UI → MCP' } } }))
      .structuredContent,
    { echo: 'UI → MCP' }
  );

  // Activity logs view
  await p.getByRole('button', { name: /调用记录/ }).click();
  await p.getByRole('heading', { name: '调用记录', exact: true }).waitFor();
  assert.ok((await p.locator('.log-row').count()) >= 2);
  await p.getByRole('button', { name: '清空记录', exact: true }).click();
  await p.getByText('暂无调用记录', { exact: true }).waitFor();

  // Clients view & mobile layout check (no horizontal overflow)
  await p.getByRole('button', { name: /接入 Agent/ }).click();
  await p.getByRole('heading', { name: 'Google Antigravity' }).waitFor();
  await p.setViewportSize({ width: 390, height: 844 });
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  // Add connection manually
  await p.getByRole('button', { name: /连接管理/ }).click();
  await p.getByRole('button', { name: /添加连接/ }).click();
  const d = p.getByRole('dialog');
  await d.getByLabel('连接 ID').fill('sleeping-http');
  await d.getByLabel('显示名').fill('测试连接');
  await d.getByLabel('连接方式').selectOption('http');
  await d.getByLabel('Streamable HTTP URL').fill('http://127.0.0.1:9/mcp');
  await d.getByLabel('启用连接').uncheck();
  await d.getByRole('button', { name: '保存连接' }).click();
  await p.getByText('测试连接', { exact: true }).waitFor();
  assert.equal(await p.getByText('已停用', { exact: true }).count(), 1);

  // Import connection via dialog
  await p.getByRole('button', { name: '导入配置', exact: true }).click();
  const imp = p.getByRole('dialog');
  await imp
    .locator('#import-text')
    .fill(JSON.stringify({ mcpServers: { 'imported-http': { url: 'https://example.com/mcp', enabled: false } } }));
  await imp.getByRole('button', { name: '解析预览', exact: true }).click();
  await imp.getByText('将导入', { exact: true }).waitFor();
  await imp.getByRole('button', { name: '确认导入', exact: true }).click();
  await p.getByText('imported-http', { exact: true }).waitFor();

  assert.deepEqual(errors, []);
  console.log(
    'PASS Chromium browser: desktop/mobile layout, connection editor, config import, permissions, descriptions, search, playground, activity logs and live MCP verification.'
  );
} finally {
  await browser?.close();
  await c.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
