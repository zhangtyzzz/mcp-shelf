#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CLI_PATH,
  defaults,
  demoSource,
  dirFromEnv,
  parseImportConfig,
  portFromEnv,
  source
} from './config.mjs';
import { answer, blocked, createMcp, httpClient, newClient, safeClose } from './catalog.mjs';
import { launch } from './server.mjs';

export { defaults, demoSource, source, parseImportConfig, createMcp, httpClient, launch };

const obj = (properties, required) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

function demoUpstream() {
  const tools = [
    {
      name: 'echo',
      description: '回显一段文字。Echo a string.',
      inputSchema: obj({ text: { type: 'string' } }, ['text']),
      outputSchema: obj({ echo: { type: 'string' } }, ['echo']),
      annotations: { readOnlyHint: true }
    },
    {
      name: 'add',
      description: '计算两个数之和。Add two numbers.',
      inputSchema: obj({ a: { type: 'number' }, b: { type: 'number' } }, ['a', 'b']),
      annotations: { readOnlyHint: true }
    }
  ];
  return createMcp(
    () => ({ tools }),
    ({ name, arguments: a }) =>
      name === 'echo'
        ? answer({ echo: a.text })
        : name === 'add'
          ? answer({ sum: a.a + a.b })
          : blocked(),
    'local-demo'
  );
}

const shutdown = (fn) => {
  let closed = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      if (!closed) {
        closed = true;
        try {
          await fn();
        } finally {
          process.exit(0);
        }
      }
    });
  }
};

function subscribeToolChanges(port, secret, onToolsChanged) {
  let req = null;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp-events',
        headers: { Authorization: 'Bearer ' + secret, Accept: 'text/event-stream' }
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          const parts = buf.split('\n\n');
          buf = parts.pop() || '';
          for (const frame of parts) {
            if (/^event:\s*tools_changed\b/m.test(frame)) {
              onToolsChanged();
            }
          }
        });
      }
    );
    req.on('error', () => {});
  };

  connect();
  return () => {
    stopped = true;
    req?.destroy();
  };
}

async function main() {
  const mode = process.argv[2] || 'serve';
  if (mode === 'demo-upstream') {
    return demoUpstream().connect(new StdioServerTransport());
  }
  if (mode === 'config') {
    return console.log(path.join(dirFromEnv(), 'config.json'));
  }
  if (mode === 'stdio') {
    let secret;
    try {
      secret = JSON.parse(fs.readFileSync(path.join(dirFromEnv(), 'config.json'), 'utf8')).token;
    } catch {
      throw new Error('Start MCP Shelf first (npm start).');
    }
    if (!/^[a-f0-9]{64}$/.test(secret || '')) {
      throw new Error('Invalid local gateway token.');
    }
    const port = portFromEnv();
    const c = newClient();
    await c.connect(
      httpClient('http://127.0.0.1:' + port + '/mcp', {
        Authorization: 'Bearer ' + secret
      }),
      { timeout: 5000 }
    );
    const s = createMcp(
      (r) => c.listTools(r.params || {}, { timeout: 60_000 }),
      (params, e) => c.callTool(params, undefined, { timeout: 60_000, signal: e.signal }),
      { instructions: c.getInstructions(), listChanged: true }
    );
    await s.connect(new StdioServerTransport());
    const stopEvents = subscribeToolChanges(port, secret, () => {
      void s.sendToolListChanged().catch(() => {});
    });
    process.stdin.once('end', () => {
      stopEvents();
      void safeClose(c);
    });
    shutdown(async () => {
      stopEvents();
      await safeClose(s);
      await safeClose(c);
    });
    return;
  }
  if (!['serve', 'demo'].includes(mode)) {
    throw new Error('Usage: mcp-shelf [serve|demo|stdio|config]');
  }
  const dir =
    mode === 'demo' && !process.env.MCP_SHELF_HOME
      ? fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shelf-demo-'))
      : dirFromEnv();
  const a = await launch({ dir, demo: mode === 'demo' });
  console.error('MCP Shelf: ' + a.url);
  shutdown(async () => {
    await a.close();
    if (mode === 'demo' && !process.env.MCP_SHELF_HOME) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(CLI_PATH)) {
  main().catch((e) => {
    console.error('MCP Shelf: ' + e.message);
    process.exitCode = 1;
  });
}
