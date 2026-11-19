import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';

export function getWsUrl(app: FastifyInstance, token?: string): string {
  const address = app.server.address() as AddressInfo;
  const port = address.port;
  return `ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`;
}

export function trackSocket(ws: WebSocket): WebSocket {
  if ((ws as any)._msgTracked) return ws;
  (ws as any)._msgTracked = true;
  const queue: any[] = [];
  const waiters: Array<{
    predicate: (data: any) => boolean;
    resolve: (data: any) => void;
    reject: (err: any) => void;
    timer: NodeJS.Timeout;
  }> = [];

  (ws as any)._msgQueue = queue;
  (ws as any)._msgWaiters = waiters;

  ws.on('message', (raw) => {
    try {
      const parsed = JSON.parse(raw.toString());
      const waiterIdx = waiters.findIndex((w) => w.predicate(parsed));
      if (waiterIdx !== -1) {
        const waiter = waiters.splice(waiterIdx, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
      } else {
        queue.push(parsed);
      }
    } catch {
      // Ignore unparseable
    }
  });

  return ws;
}

export function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    trackSocket(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', (err) => reject(err));
  });
}

export function waitForMessage(
  ws: WebSocket,
  predicate?: (data: any) => boolean,
  timeoutMs = 3000
): Promise<any> {
  trackSocket(ws);
  const queue = (ws as any)._msgQueue as any[];
  const waiters = (ws as any)._msgWaiters as Array<{
    predicate: (data: any) => boolean;
    resolve: (data: any) => void;
    reject: (err: any) => void;
    timer: NodeJS.Timeout;
  }>;
  const pred = predicate || (() => true);

  // Check buffered messages
  const queueIdx = queue.findIndex(pred);
  if (queueIdx !== -1) {
    const item = queue.splice(queueIdx, 1)[0];
    return Promise.resolve(item);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waiters.findIndex((w) => w.timer === timer);
      if (idx !== -1) waiters.splice(idx, 1);
      reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    waiters.push({
      predicate: pred,
      resolve,
      reject,
      timer,
    });
  });
}

export function waitForClose(
  ws: WebSocket,
  timeoutMs = 3000
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`waitForClose timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

export interface MockCoreServer {
  url: string;
  setRelationship(targetUserId: string, state: { blocked: boolean }): void;
  close(): Promise<void>;
}

export function startMockCoreServer(port = 0): Promise<MockCoreServer> {
  const relationships = new Map<string, { blocked: boolean }>();

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url || '', 'http://127.0.0.1');
    if (parsedUrl.pathname === '/relationships/check') {
      const userIds = (parsedUrl.searchParams.get('userIds') || '').split(',').filter(Boolean);
      const data: Record<string, any> = {};
      for (const id of userIds) {
        data[id] = relationships.get(id) || {
          blocked: false,
          muted: { calls: false, messages: false },
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        setRelationship(targetUserId: string, state: { blocked: boolean }) {
          relationships.set(targetUserId, state);
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
