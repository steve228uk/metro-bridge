import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { CDPSession } from './session.js';
import type { MetroTarget } from './types.js';

type ReactNativeCapabilities = NonNullable<MetroTarget['reactNative']>['capabilities'];

function makeTarget(
  port: number,
  capabilities: ReactNativeCapabilities,
  host = '127.0.0.1',
): MetroTarget {
  return {
    id: 'target-1',
    title: 'Test app',
    description: 'React Native',
    type: 'node',
    webSocketDebuggerUrl: `ws://${host}:${port}/inspector/debug?device=device-1&page=1`,
    reactNative: {
      capabilities,
    },
  };
}

async function captureOriginHeader(
  capabilities: ReactNativeCapabilities,
  host?: string,
): Promise<string | undefined> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const sockets = new Set<WebSocket>();
  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      resolve((httpServer.address() as AddressInfo).port);
    });
  });

  const origin = new Promise<string | undefined>((resolve) => {
    wss.on('connection', (ws, req) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      resolve(req.headers.origin);
    });
  });

  const session = new CDPSession();
  try {
    await session.connectToTarget(makeTarget(port, capabilities, host));
    return await origin;
  } finally {
    session.disconnect();
    for (const socket of sockets) {
      socket.terminate();
    }
    wss.close();
    httpServer.close();
  }
}

describe('CDPSession Origin header', () => {
  test('does not send Origin for RN <0.85 Fusebox /inspector/debug targets', async () => {
    await expect(captureOriginHeader({ prefersFuseboxFrontend: true })).resolves.toBeUndefined();
  });

  test('sends Origin for targets that explicitly support multiple debuggers', async () => {
    await expect(captureOriginHeader({ supportsMultipleDebuggers: true })).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('normalizes localhost debugger URLs to a 127.0.0.1 Origin', async () => {
    await expect(captureOriginHeader({ supportsMultipleDebuggers: true }, 'localhost')).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

type SessionSocket = WebSocket & { send: (data: string) => void };

async function createSessionServer(
  onMessage: (socket: WebSocket, request: { id: number; method: string; params?: Record<string, unknown> }) => void,
): Promise<{ session: CDPSession; close: () => Promise<void> }> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const sockets = new Set<WebSocket>();
  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      resolve((httpServer.address() as AddressInfo).port);
    });
  });

  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data) => {
      onMessage(socket, JSON.parse(data.toString()) as { id: number; method: string; params?: Record<string, unknown> });
    });
  });

  const session = await CDPSession.connect(makeTarget(port, {}));
  return {
    session,
    close: async () => {
      session.disconnect();
      for (const socket of sockets) socket.terminate();
      wss.close();
      httpServer.close();
    },
  };
}

function pendingRequestCount(session: CDPSession): number {
  return (session as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.size;
}

describe('CDPSession request timeouts', () => {
  const resources: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(resources.splice(0).map(resource => resource.close()));
  });

  test('waits for a delayed response with the default timeout', async () => {
    const resource = await createSessionServer((socket, request) => {
      setTimeout(() => socket.send(JSON.stringify({ id: request.id, result: { ok: true } })), 40);
    });
    resources.push(resource);

    await expect(resource.session.send('Runtime.enable')).resolves.toEqual({ ok: true });
  });

  test('uses a custom timeout and removes the expired request', async () => {
    const resource = await createSessionServer((socket, request) => {
      setTimeout(() => socket.send(JSON.stringify({ id: request.id, result: { late: true } })), 50);
    });
    resources.push(resource);

    await expect(resource.session.send('Runtime.evaluate', undefined, { timeoutMs: 10 })).rejects.toThrow(
      'CDP request timed out: Runtime.evaluate',
    );
    expect(pendingRequestCount(resource.session)).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(pendingRequestCount(resource.session)).toBe(0);
  });

  test('rejects invalid request timeouts', async () => {
    const resource = await createSessionServer(() => {});
    resources.push(resource);

    await expect(resource.session.send('Runtime.enable', undefined, { timeoutMs: 0 })).rejects.toThrow(
      'finite positive number',
    );
    await expect(resource.session.send('Runtime.enable', undefined, { timeoutMs: Number.NaN })).rejects.toThrow(
      'finite positive number',
    );
    await expect(resource.session.send('Runtime.enable', undefined, { timeoutMs: Number.POSITIVE_INFINITY })).rejects.toThrow(
      'finite positive number',
    );
    expect(pendingRequestCount(resource.session)).toBe(0);
  });

  test('cleans up when the WebSocket send throws synchronously', async () => {
    const resource = await createSessionServer((socket, request) => {
      socket.send(JSON.stringify({ id: request.id, result: { recovered: true } }));
    });
    resources.push(resource);
    const socket = (resource.session as unknown as { ws: SessionSocket }).ws;
    const originalSend = socket.send;
    socket.send = () => {
      throw new Error('synchronous send failure');
    };

    await expect(resource.session.send('Runtime.enable')).rejects.toThrow('synchronous send failure');
    expect(pendingRequestCount(resource.session)).toBe(0);

    socket.send = originalSend;
    await expect(resource.session.send('Runtime.enable')).resolves.toEqual({ recovered: true });
  });

  test('tracks concurrent requests independently', async () => {
    const resource = await createSessionServer((socket, request) => {
      const delay = request.params?.delay as number;
      setTimeout(() => socket.send(JSON.stringify({ id: request.id, result: request.id })), delay);
    });
    resources.push(resource);

    const first = resource.session.send<number>('Runtime.evaluate', { delay: 30 }, { timeoutMs: 100 });
    const second = resource.session.send<number>('Runtime.evaluate', { delay: 5 }, { timeoutMs: 100 });
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(pendingRequestCount(resource.session)).toBe(0);
  });
});
