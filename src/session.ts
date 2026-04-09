import WebSocket from 'ws';
import type { CDPRequest, CDPResponse, MetroTarget } from './types.js';
import { createLogger } from './utils/logger.js';
import { wsDataToString } from './utils/ws.js';

const logger = createLogger('cdp');

type CDPEventHandler = (params: Record<string, unknown>) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * CDP WebSocket client that connects to a Hermes debugger target.
 *
 * Uses the `ws` library (same as Metro's InspectorProxy) for native
 * WebSocket ping/pong support. Metro sends pings every 5s and terminates
 * connections after 60s of no pong — `ws` auto-responds to pings.
 */
export class CDPSession {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private eventHandlers = new Map<string, Set<CDPEventHandler>>();
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private connectingPromise: Promise<void> | null = null;
  private suppressReconnect = false;
  private _isConnected = false;
  private target: MetroTarget | null = null;
  private lastPingAt = 0;

  /**
   * Optional interceptor for parsed incoming CDP messages.
   * If set and returns true, the message is consumed by the interceptor
   * and won't be processed by CDPSession's own handleMessage logic.
   * Used by CDPMultiplexer to route responses to external clients.
   */
  messageInterceptor: ((parsed: CDPResponse, raw: string) => boolean) | null = null;

  // 30s timeout: Fusebox (RN 0.77–0.84) may take longer than the classic Hermes
  // inspector to acknowledge domain-enable commands during JS context initialisation.
  private readonly requestTimeout = 30000;
  private readonly keepAliveInterval = 10000;

  /**
   * Open a CDP session to the given target.
   */
  static async connect(target: MetroTarget): Promise<CDPSession> {
    const session = new CDPSession();
    await session.connectToTarget(target);
    return session;
  }

  /**
   * Connect to a CDP target.
   */
  async connectToTarget(target: MetroTarget): Promise<void> {
    this.stopKeepAlive();
    this.target = target;
    this.suppressReconnect = false;
    this.connectingPromise = this.doConnect(target.webSocketDebuggerUrl);
    await this.connectingPromise;
    this.connectingPromise = null;
    this.emit('reconnected', {});
  }

  async waitForConnection(): Promise<boolean> {
    if (this._isConnected) return true;
    if (this.connectingPromise) {
      try { await this.connectingPromise; } catch {}
    }
    return this._isConnected;
  }

  private doConnect(url: string): Promise<void> {
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
      this.ws = null;
    }
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
        const socketForThisConnection = this.ws;

        this.ws.on('open', () => {
          this._isConnected = true;
          this.lastPingAt = Date.now();
          this.startKeepAlive();
          logger.info(`Connected to ${this.target?.title || 'unknown'}`);
          resolve();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(wsDataToString(data));
        });

        this.ws.on('close', (code, reason) => {
          if (this.ws !== socketForThisConnection) return;

          logger.info(`WebSocket closed (code=${code}, reason="${reason.toString() || 'no reason'}", wasConnected=${this._isConnected})`);

          this._isConnected = false;
          this.stopKeepAlive();
          this.rejectAllPending('WebSocket closed');
          if (!this.suppressReconnect) {
            this.emit('disconnected', {});
          }
        });

        this.ws.on('error', () => {
          logger.error(`WebSocket error (connected=${this._isConnected})`);
          if (!this._isConnected) {
            reject(new Error('Failed to connect to CDP target'));
          }
        });

        // Metro's InspectorProxy sends WebSocket pings on device connections
        // (/inspector/device) but NOT on debugger connections (/inspector/debug).
        // Only update lastPingAt on actual WebSocket pings so the keepalive
        // correctly detects dead connections and triggers a reconnect.
        this.ws.on('ping', () => {
          this.lastPingAt = Date.now();
          logger.debug('Received ping from Metro');
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Send a CDP command and wait for the response.
   */
  async send<TResult = unknown>(method: string, params?: Record<string, unknown>): Promise<TResult> {
    if (!this.ws || !this._isConnected) {
      throw new Error('Not connected to CDP target');
    }

    const id = ++this.messageId;
    const request: CDPRequest = { id, method };
    if (params) request.params = params;

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, {
        resolve: v => resolve(v as TResult),
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify(request));
    });
  }

  /**
   * Subscribe to a CDP event.
   */
  on(event: string, handler: CDPEventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Unsubscribe from a CDP event.
   */
  off(event: string, handler: CDPEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Get the current target.
   */
  getTarget(): MetroTarget | null {
    return this.target;
  }

  /**
   * Disconnect and stop reconnecting.
   */
  disconnect(): void {
    this.suppressReconnect = true;
    this.stopKeepAlive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._isConnected = false;
    this.rejectAllPending('Disconnected');
  }

  close(): void {
    this.disconnect();
  }

  /**
   * Send a raw string message upstream. Used by CDPMultiplexer.
   */
  sendRaw(data: string): void {
    if (!this.ws || !this._isConnected) {
      throw new Error('Not connected to CDP target');
    }
    this.ws.send(data);
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this._isConnected || !this.ws) return;

      // Metro sends pings on device connections but not on debugger connections.
      // Use a generous timeout so the keepalive doesn't interfere with normal CDP
      // request/response cycles on long-lived debugger sessions.
      const elapsed = Date.now() - this.lastPingAt;
      if (elapsed > 120000) {
        logger.warn(`No ping received from Metro in ${elapsed}ms — closing connection`);
        try { this.ws.close(); } catch {}
      }
    }, this.keepAliveInterval);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private handleMessage(data: string): void {
    let message: CDPResponse;
    try {
      message = JSON.parse(data);
    } catch {
      logger.warn('Failed to parse CDP message');
      return;
    }

    if (this.messageInterceptor?.(message, data)) return;

    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    if (message.method) {
      this.emit(message.method, message.params || {});
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  private emit(event: string, params: Record<string, unknown>): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(params);
        } catch (err) {
          logger.error(`Error in event handler for ${event}:`, err);
        }
      }
    }
  }
}
