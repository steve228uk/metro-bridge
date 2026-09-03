import { describe, expect, test } from 'bun:test';
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
