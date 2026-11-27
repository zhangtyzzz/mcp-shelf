import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launch } from '../src/main.mjs';

const exec = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-grok-test-'));
const grokHome = path.join(root, 'grok-home');
fs.mkdirSync(grokHome, { recursive: true });
const app = await launch({ dir: path.join(root, 'shelf'), port: 0, demo: true });
const cmd = process.env.GROK_BIN || 'grok';
const cli = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
const env = { ...process.env, GROK_HOME: grokHome };
const go = async (args) => (await exec(cmd, args, { cwd: root, env, timeout: 25_000 })).stdout.trim();

try {
  await go([
    'mcp',
    'add',
    '--scope',
    'user',
    'mcp_shelf',
    '-e',
    'MCP_SHELF_HOME=' + app.config.dir,
    '-e',
    'MCP_SHELF_PORT=' + app.server.address().port,
    '--',
    process.execPath,
    cli,
    'stdio'
  ]);
  const listed = await go(['mcp', 'list', '--json']);
  assert.match(listed, /mcp_shelf/);
  const doctor = await go(['mcp', 'doctor', 'mcp_shelf']);
  console.log(doctor);
  assert.match(doctor, /list_mcps|3 tools|healthy|✓/i);
  console.log('PASS real Grok Build CLI registration & doctor verification.');
} finally {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
