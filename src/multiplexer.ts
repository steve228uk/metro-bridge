import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import type { CDPSession } from './session.js';
import type { CDPResponse } from './types.js';
import { createLogger } from './utils/logger.js';
import { wsDataToString } from './utils/ws.js';

const logger = createLogger('cdp-multiplexer');

const PENDING_REQUEST_TIMEOUT = 30_000;

interface ExternalClient {
  id: string;
  ws: WebSocket;
  enabledDomains: Set<string>;
}

interface PendingProxyRequest {
  clientId: string;
  originalId: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * CDP Multiplexer.
 *
 * Sits between Hermes (single CDP connection via CDPSession) and multiple
 * downstream consumers: your server-side code and Chrome DevTools or other
 * external clients (via WebSocket).
 *
 * - Requests from external clients get ID-remapped before forwarding upstream.
 * - Responses are routed back to the originating client only.
 * - Events are broadcast to ALL connected clients.
 * - Domain enable/disable is reference-counted so clients don't interfere.
 */
export class CDPMultiplexer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ExternalClient>();
  private pendingRequests = new Map<number, PendingProxyRequest>();
  private domainRefCounts = new Map<string, number>();
  private nextGlobalId = 1_000_000;
  private clientCounter = 0;
  private _port: number | null = null;
  private protectedDomains: Set<string>;

  constructor(
    private readonly cdpSession: CDPSession,
    options?: { protectedDomains?: string[] },
  ) {
    this.protectedDomains = new Set(options?.protectedDomains ?? []);

    const target = cdpSession.getTarget();
    if (target?.reactNative?.capabilities?.supportsMultipleDebuggers) {
      logger.debug(
        'CDPMultiplexer is not needed: target reports supportsMultipleDebuggers=true. ' +
        'On RN 0.85+ Metro handles multiple concurrent connections natively.',
      );
    }

    // Install the message interceptor on CDPSession to intercept responses
    // destined for external clients and broadcast events.
    cdpSession.messageInterceptor = (parsed: CDPResponse, raw: string) =>
      this.handleUpstreamMessage(parsed, raw);

    cdpSession.on('reconnected', () => {
      this.reEnableDomains();
    });

    cdpSession.on('disconnected', () => {
      for (const client of this.clients.values()) {
        this.sendToClient(client, JSON.stringify({
          method: 'Inspector.detached',
          params: { reason: 'target_closed' },
        }));
      }
    });
  }

  get port(): number | null {
    return this._port;
  }

  /**
   * Start the multiplexer's HTTP + WebSocket server.
   */
  async start(port = 0): Promise<number> {
    const tryPort = (p: number): Promise<number> => new Promise((resolve, reject) => {
      const httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
      httpServer.on('error', (err) => {
        httpServer.close();
        reject(err);
      });
      httpServer.listen(p, () => {
        const addr = httpServer.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : p;
        const wss = new WebSocketServer({ server: httpServer });
        wss.on('connection', (ws) => this.handleNewClient(ws));
        this.httpServer = httpServer;
        this.wss = wss;
        this._port = actualPort;
        logger.info(`CDP multiplexer listening on port ${actualPort}`);
        resolve(actualPort);
      });
    });

    if (port !== 0) {
      try {
        return await tryPort(port);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
        logger.debug(`Preferred port ${port} in use, falling back to auto-assign`);
      }
    }
    return tryPort(0);
  }

  /**
   * Stop the multiplexer server.
   */
  async stop(): Promise<void> {
    for (const client of this.clients.values()) {
      try { client.ws.close(); } catch {}
    }
    this.clients.clear();
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingRequests.clear();
    this.domainRefCounts.clear();

    this.cdpSession.messageInterceptor = null;

    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          if (this.httpServer) {
            this.httpServer.close(() => resolve());
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the Chrome DevTools frontend URL for this multiplexer.
   */
  getDevToolsUrl(): string | null {
    if (!this._port) return null;
    return `chrome-devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=127.0.0.1:${this._port}`;
  }

  // ── HTTP handler ────────────────────────────────────────────────────────────

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/json' || req.url === '/json/list') {
      const target = this.cdpSession.getTarget();
      const targetList = target ? [{
        description: target.description || '',
        devtoolsFrontendUrl: this.getDevToolsUrl(),
        id: target.id,
        title: target.title,
        type: 'node',
        webSocketDebuggerUrl: `ws://localhost:${this._port}`,
        ...(target.vm ? { vm: target.vm } : {}),
      }] : [];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targetList));
      return;
    }

    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Browser: 'metro-bridge/CDP-Multiplexer',
        'Protocol-Version': '1.3',
      }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  // ── WebSocket client handling ───────────────────────────────────────────────

  private handleNewClient(ws: WebSocket): void {
    const clientId = `client-${++this.clientCounter}`;
    const client: ExternalClient = { id: clientId, ws, enabledDomains: new Set() };
    this.clients.set(clientId, client);
    logger.info(`External client connected: ${clientId}`);

    ws.on('message', (data) => {
      this.handleClientMessage(client, wsDataToString(data));
    });

    ws.on('close', () => {
      logger.info(`External client disconnected: ${clientId}`);
      this.cleanupClient(client);
    });

    ws.on('error', (err) => {
      logger.error(`Client ${clientId} error: ${err.message}`);
    });
  }

  private handleClientMessage(client: ExternalClient, data: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(data);
    } catch {
      logger.warn(`Invalid JSON from client ${client.id}`);
      return;
    }

    if (message.id === undefined || !message.method) {
      try { this.cdpSession.sendRaw(data); } catch {}
      return;
    }

    const method = message.method;
    const isEnable = method.endsWith('.enable');
    const isDisable = !isEnable && method.endsWith('.disable');

    if (isEnable || isDisable) {
      const domain = method.slice(0, method.lastIndexOf('.'));
      const refCount = this.domainRefCounts.get(domain) || 0;

      if (isEnable) {
        client.enabledDomains.add(domain);
        if (refCount > 0) {
          this.domainRefCounts.set(domain, refCount + 1);
          this.sendToClient(client, JSON.stringify({ id: message.id, result: {} }));
          return;
        }
        this.domainRefCounts.set(domain, 1);
      } else {
        client.enabledDomains.delete(domain);
        if (refCount > 1) {
          this.domainRefCounts.set(domain, refCount - 1);
          this.sendToClient(client, JSON.stringify({ id: message.id, result: {} }));
          return;
        }
        if (refCount === 1) this.domainRefCounts.set(domain, 0);
      }
    }

    const globalId = this.nextGlobalId++;
    const timer = setTimeout(() => {
      this.pendingRequests.delete(globalId);
      this.sendToClient(client, JSON.stringify({
        id: message.id,
        error: { code: -32000, message: 'CDP request timed out' },
      }));
    }, PENDING_REQUEST_TIMEOUT);
    this.pendingRequests.set(globalId, { clientId: client.id, originalId: message.id!, timer });

    const remapped = { ...message, id: globalId };
    try {
      this.cdpSession.sendRaw(JSON.stringify(remapped));
    } catch {
      clearTimeout(timer);
      this.pendingRequests.delete(globalId);
      this.sendToClient(client, JSON.stringify({
        id: message.id,
        error: { code: -32000, message: 'Upstream CDP connection not available' },
      }));
    }
  }

  // ── Upstream message handling ───────────────────────────────────────────────

  private handleUpstreamMessage(message: CDPResponse, raw: string): boolean {
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        const client = this.clients.get(pending.clientId);
        if (client) {
          const remapped = { ...message, id: pending.originalId };
          this.sendToClient(client, JSON.stringify(remapped));
        }
        return true;
      }
      return false;
    }

    if (message.method) {
      for (const client of this.clients.values()) {
        this.sendToClient(client, raw);
      }
    }

    return false;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private sendToClient(client: ExternalClient, data: string): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }

  private cleanupClient(client: ExternalClient): void {
    for (const domain of client.enabledDomains) {
      const refCount = this.domainRefCounts.get(domain) || 0;
      if (refCount > 0) {
        this.domainRefCounts.set(domain, refCount - 1);
        if (refCount === 1 && !this.protectedDomains.has(domain)) {
          try {
            this.cdpSession.sendRaw(JSON.stringify({
              id: this.nextGlobalId++,
              method: `${domain}.disable`,
            }));
          } catch {}
        }
      }
    }
    this.clients.delete(client.id);

    for (const [globalId, pending] of this.pendingRequests) {
      if (pending.clientId === client.id) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(globalId);
      }
    }
  }

  private reEnableDomains(): void {
    const domainsToEnable = new Set<string>();
    for (const client of this.clients.values()) {
      for (const domain of client.enabledDomains) {
        domainsToEnable.add(domain);
      }
    }
    for (const domain of domainsToEnable) {
      try {
        this.cdpSession.sendRaw(JSON.stringify({
          id: this.nextGlobalId++,
          method: `${domain}.enable`,
        }));
      } catch {}
    }
  }
}
