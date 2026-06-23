import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { probeCDPConnection } from './probe.js';
import type { MetroTarget } from './types.js';

const DEFAULT_PROBE_METHOD = 'Schema.getDomains';

interface ProbeServer {
  server: Server;
  wss: WebSocketServer;
  port: number;
}

interface RawServer {
  server: Server;
  sockets: Set<Duplex>;
}

const servers: ProbeServer[] = [];
const rawServers: RawServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    closeProbeServer(server);
  }
  for (const server of rawServers.splice(0)) {
    closeRawServer(server);
  }
});

function targetFor(port: number): MetroTarget {
  return {
    id: 'page-1',
    title: 'Hermes React Native',
    description: 'React Native Bridgeless [C++ connection]',
    type: 'node',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?page=1`,
    reactNative: {
      capabilities: {
        supportsMultipleDebuggers: true,
      },
    },
  };
}

async function createProbeServer(
  onConnection: (ws: WebSocket) => void,
): Promise<ProbeServer> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', onConnection);

  const port = await listenOnLocalhost(server);

  const probeServer = {
    server,
    wss,
    port,
  };
  servers.push(probeServer);
  return probeServer;
}

async function listenOnLocalhost(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeProbeServer({ server, wss }: ProbeServer): void {
  for (const client of wss.clients) {
    client.terminate();
  }
  wss.close();
  server.close();
}

function closeRawServer({ server, sockets }: RawServer): void {
  for (const socket of sockets) {
    socket.destroy();
  }
  server.close();
}

async function createStalledUpgradeServer(): Promise<number> {
  const server = createServer();
  const sockets = new Set<Duplex>();
  server.on('upgrade', (_request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const port = await listenOnLocalhost(server);

  rawServers.push({ server, sockets });
  return port;
}

describe('probeCDPConnection', () => {
  test('reports ok when the target responds to the probe command', async () => {
    const { port } = await createProbeServer((ws) => {
      ws.on('message', (data) => {
        const request = JSON.parse(data.toString()) as { id: number };
        ws.send(JSON.stringify({ id: request.id, result: { domains: [] } }));
      });
    });

    await expect(probeCDPConnection(targetFor(port))).resolves.toMatchObject({
      ok: true,
      method: DEFAULT_PROBE_METHOD,
    });
  });

  test('reports closed when the target closes after the probe command', async () => {
    const { port } = await createProbeServer((ws) => {
      ws.on('message', () => {
        ws.terminate();
      });
    });

    const result = await probeCDPConnection(targetFor(port));

    expect(result).toMatchObject({
      ok: false,
      reason: 'closed',
      method: DEFAULT_PROBE_METHOD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.closeInfo?.code).toBe(1006);
    }
  });

  test('reports timeout when the target does not answer the probe command', async () => {
    const { port } = await createProbeServer(() => {});

    await expect(
      probeCDPConnection(targetFor(port), { timeoutMs: 20 }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'timeout',
      method: DEFAULT_PROBE_METHOD,
    });
  });

  test('reports timeout when the WebSocket handshake stalls', async () => {
    const port = await createStalledUpgradeServer();

    await expect(
      probeCDPConnection(targetFor(port), { timeoutMs: 20 }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'timeout',
      method: DEFAULT_PROBE_METHOD,
    });
  });

  test('reports error when the target cannot be reached', async () => {
    const server = createServer();
    const port = await listenOnLocalhost(server);
    await closeServer(server);

    await expect(
      probeCDPConnection(targetFor(port), { timeoutMs: 20 }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'error',
      method: DEFAULT_PROBE_METHOD,
    });
  });
});
