import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { token } from './config.mjs';

const MAX_TASKS = 100;
const DEFAULT_TTL_MS = 15 * 60_000;

/**
 * In-memory MCP 2025-11-25 Tasks manager for long-running asynchronous tool calls.
 * Supports tasks/get, tasks/result, tasks/list, and tasks/cancel.
 */
export class TaskManager {
  constructor() {
    this.tasks = new Map();
    this.reaper = setInterval(() => this.prune(), 60_000);
    this.reaper.unref();
  }

  prune() {
    const now = Date.now();
    for (const [id, rec] of this.tasks) {
      if (rec.status !== 'working' && now - rec.updatedAtMs > rec.ttl) {
        this.tasks.delete(id);
      }
    }
    while (this.tasks.size > MAX_TASKS) {
      const oldest = this.tasks.keys().next().value;
      if (!oldest) break;
      const rec = this.tasks.get(oldest);
      if (rec?.status === 'working') break;
      this.tasks.delete(oldest);
    }
  }

  toProtocol(rec) {
    return {
      taskId: rec.taskId,
      status: rec.status,
      ...(rec.statusMessage ? { statusMessage: rec.statusMessage } : {}),
      createdAt: rec.createdAt,
      lastUpdatedAt: rec.lastUpdatedAt,
      ttl: rec.ttl,
      pollInterval: 1000
    };
  }

  start({ toolId, profileId = null, ttl = DEFAULT_TTL_MS, run }) {
    this.prune();
    const taskId = 'task_' + token().slice(0, 20);
    const now = new Date();
    const controller = new AbortController();
    let resolveDone;
    const done = new Promise((r) => {
      resolveDone = r;
    });

    const rec = {
      taskId,
      toolId,
      profileId,
      status: 'working',
      statusMessage: `Running ${toolId}`,
      createdAt: now.toISOString(),
      lastUpdatedAt: now.toISOString(),
      updatedAtMs: now.getTime(),
      ttl: Math.min(Math.max(Number(ttl) || DEFAULT_TTL_MS, 5_000), 60 * 60_000),
      controller,
      result: null,
      done
    };

    this.tasks.set(taskId, rec);

    Promise.resolve()
      .then(() => run(controller.signal))
      .then((res) => {
        if (rec.status !== 'working') return;
        rec.result = res;
        rec.status = res?.isError ? 'failed' : 'completed';
        rec.statusMessage = res?.isError ? 'Tool returned an error' : 'Completed';
      })
      .catch((err) => {
        if (rec.status !== 'working') return;
        rec.status = controller.signal.aborted ? 'cancelled' : 'failed';
        rec.statusMessage = err?.message || 'Task failed';
        rec.result = {
          content: [{ type: 'text', text: rec.statusMessage }],
          isError: true
        };
      })
      .finally(() => {
        rec.lastUpdatedAt = new Date().toISOString();
        rec.updatedAtMs = Date.now();
        resolveDone(rec.result);
      });

    return this.toProtocol(rec);
  }

  get(taskId, profileId = null) {
    const rec = this.tasks.get(taskId);
    if (!rec || (profileId && rec.profileId !== profileId)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown task: ${taskId}`);
    }
    return this.toProtocol(rec);
  }

  async result(taskId, profileId = null, signal) {
    const rec = this.tasks.get(taskId);
    if (!rec || (profileId && rec.profileId !== profileId)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown task: ${taskId}`);
    }
    if (rec.status === 'working') {
      await Promise.race([
        rec.done,
        new Promise((_, reject) => {
          if (signal?.aborted) reject(new Error('Aborted'));
          signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
        })
      ]);
    }
    return rec.result || { content: [{ type: 'text', text: rec.statusMessage || rec.status }], isError: rec.status !== 'completed' };
  }

  list(profileId = null) {
    const items = [];
    for (const rec of this.tasks.values()) {
      if (profileId && rec.profileId !== profileId) continue;
      items.push(this.toProtocol(rec));
    }
    return { tasks: items };
  }

  cancel(taskId, profileId = null) {
    const rec = this.tasks.get(taskId);
    if (!rec || (profileId && rec.profileId !== profileId)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown task: ${taskId}`);
    }
    if (rec.status === 'working') {
      rec.status = 'cancelled';
      rec.statusMessage = 'Cancelled by client';
      rec.lastUpdatedAt = new Date().toISOString();
      rec.updatedAtMs = Date.now();
      rec.result = { content: [{ type: 'text', text: 'Task cancelled.' }], isError: true };
      rec.controller.abort();
    }
    return this.toProtocol(rec);
  }

  snapshot() {
    return [...this.tasks.values()].reverse().map((rec) => ({
      ...this.toProtocol(rec),
      toolId: rec.toolId,
      profileId: rec.profileId
    }));
  }

  close() {
    clearInterval(this.reaper);
    for (const rec of this.tasks.values()) {
      if (rec.status === 'working') rec.controller.abort();
    }
    this.tasks.clear();
  }
}
