import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  checkMetroStatus,
  fetchTargets,
  MetroDiscovery,
  scanMetroPorts,
} from './discovery.js';
import type { MetroTarget } from './types.js';

const originalFetch = globalThis.fetch;

const targets: MetroTarget[] = [
  {
    id: 'page-1',
    title: 'Hermes React Native',
    description: 'React Native Bridgeless',
    type: 'node',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?page=1',
  },
];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function createMetroServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === '/status') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('packager-status:running');
      return;
    }

    if (request.url === '/json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(targets));
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    server,
    port: (server.address() as AddressInfo).port,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function withMetroServer(
  run: (server: { port: number }) => Promise<void>,
): Promise<void> {
  const { server, port } = await createMetroServer();

  try {
    await run({ port });
  } finally {
    await closeServer(server);
  }
}

function metroUrl(host: string, port: number, path: string): string {
  return `http://${host}:${port}${path}`;
}

function getFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function mockLocalhostFetchFailure(calls?: string[]): void {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = getFetchUrl(input);
    calls?.push(url);

    if (new URL(url).hostname === 'localhost') {
      throw new Error('localhost unavailable');
    }

    return originalFetch(input, init);
  }) as unknown as typeof fetch;
}

describe('Metro discovery host fallback', () => {
  test('checkMetroStatus succeeds against 127.0.0.1', async () => {
    await withMetroServer(async ({ port }) => {
      await expect(checkMetroStatus('127.0.0.1', port)).resolves.toBe(
        'packager-status:running',
      );
    });
  });

  test('checkMetroStatus falls back from localhost to 127.0.0.1', async () => {
    await withMetroServer(async ({ port }) => {
      const calls: string[] = [];
      mockLocalhostFetchFailure(calls);

      await expect(checkMetroStatus('localhost', port)).resolves.toBe(
        'packager-status:running',
      );
      expect(calls).toEqual([
        metroUrl('localhost', port, '/status'),
        metroUrl('127.0.0.1', port, '/status'),
      ]);
    });
  });

  test('fetchTargets falls back from localhost to 127.0.0.1', async () => {
    await withMetroServer(async ({ port }) => {
      mockLocalhostFetchFailure();

      await expect(fetchTargets('localhost', port)).resolves.toEqual(targets);
    });
  });

  test('scanMetroPorts reports the host that answered after fallback', async () => {
    await withMetroServer(async ({ port }) => {
      mockLocalhostFetchFailure();

      await expect(scanMetroPorts('localhost', port)).resolves.toEqual([
        { host: '127.0.0.1', port, targets },
      ]);
    });
  });

  test('MetroDiscovery uses localhost fallback for configured hosts', async () => {
    await withMetroServer(async ({ port }) => {
      mockLocalhostFetchFailure();

      const discovery = new MetroDiscovery(port, 'localhost');

      await expect(discovery.discover()).resolves.toEqual(targets);
      await expect(discovery.isMetroRunning()).resolves.toBe(true);
    });
  });

  test('custom hosts do not fall back to 127.0.0.1', async () => {
    await withMetroServer(async ({ port }) => {
      const calls: string[] = [];

      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = getFetchUrl(input);
        calls.push(url);
        throw new Error('custom host unavailable');
      }) as unknown as typeof fetch;

      await expect(checkMetroStatus('metro.local', port)).resolves.toBeNull();
      expect(calls).toEqual([metroUrl('metro.local', port, '/status')]);
    });
  });
});
