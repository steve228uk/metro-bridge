import { MetroDiscovery } from './discovery.js';
import type { CDPSession } from './session.js';
import type { ConsoleHandler, MockResponse } from './types.js';
import { poll } from './utils/poll.js';

export type { ConsoleHandler, MockResponse };

/**
 * High-level Metro CDP bridge.
 *
 * Connects to Hermes via Metro's inspector WebSocket, exposing:
 *   - JS evaluation in the app context (Runtime.evaluate)
 *   - React Native idle detection (InteractionManager)
 *   - Console log capture
 *   - JS-layer network request mocking (via fetch/XHR patch)
 *
 * Available in dev mode only. Use MetroBridge.tryConnect() in test fixtures
 * so the library gracefully falls back when Metro is not running.
 */
export class MetroBridge {
  private constructor(
    private readonly session: CDPSession,
  ) {}

  // ─── Connection ───────────────────────────────────────────────────────────

  /**
   * Connect to Metro and return a MetroBridge.
   * Throws if Metro is not running or no debuggable target is found.
   */
  static async connect(metroPort = 8081): Promise<MetroBridge> {
    const discovery = new MetroDiscovery(metroPort);
    const session = await discovery.attach();
    // Enable required CDP domains. New-arch Fusebox doesn't ack these commands,
    // so we fire-and-forget rather than awaiting (which would hang forever).
    session.send('Runtime.enable').catch(() => {});
    return new MetroBridge(session);
  }

  /**
   * Attempt to connect to Metro. Returns null (never throws) if unavailable.
   * Ideal for test fixtures where dev mode is optional.
   */
  static async tryConnect(metroPort = 8081): Promise<MetroBridge | null> {
    try {
      return await MetroBridge.connect(metroPort);
    } catch {
      return null;
    }
  }

  // ─── JS evaluation ────────────────────────────────────────────────────────

  /**
   * Execute a JavaScript expression in the app's Hermes context.
   * Returns the JSON-serialisable result.
   *
   * @example
   * const count = await bridge.evaluate<number>('globalThis.__itemCount')
   */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = await this.session.send<RuntimeEvaluateResult>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (res.exceptionDetails) {
      throw new Error(
        `JS evaluation error: ${res.exceptionDetails.text ?? JSON.stringify(res.exceptionDetails)}`,
      );
    }

    return res.result.value as T;
  }

  // ─── Idle detection ───────────────────────────────────────────────────────

  /**
   * Wait until React Native's InteractionManager reports idle.
   * This means all animations and interactions have settled — more
   * reliable than a fixed sleep().
   *
   * Falls back gracefully if InteractionManager is unavailable.
   */
  async waitForIdle(timeout = 5000): Promise<void> {
    await poll(async () => {
      try {
        const idle = await Promise.race([
          this.evaluate<boolean>(`
            new Promise(resolve => {
              try {
                const { InteractionManager } = require('react-native');
                InteractionManager.runAfterInteractions(() => resolve(true));
              } catch (_) {
                resolve(true);
              }
            })
          `),
          new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 500)),
        ]);
        return idle ? true : null;
      } catch {
        return true; // non-fatal — treat as idle
      }
    }, timeout, 50);
  }

  // ─── Console capture ──────────────────────────────────────────────────────

  /**
   * Register a handler for console messages from the app.
   * Returns an unsubscribe function.
   */
  onConsole(handler: ConsoleHandler): () => void {
    const listener = (params: unknown) => {
      const p = params as RuntimeConsoleParams;
      handler(
        p.type,
        p.args.map(a => (a as ConsoleArg).value ?? (a as ConsoleArg).description ?? (a as ConsoleArg).type),
      );
    };
    this.session.on('Runtime.consoleAPICalled', listener);
    return () => this.session.off('Runtime.consoleAPICalled', listener);
  }

  // ─── Network mocking ──────────────────────────────────────────────────────

  /**
   * Inject a JS-layer fetch interceptor to mock matching requests.
   * Note: This patches `globalThis.fetch` inside Hermes — it does NOT use
   * the CDP Network domain (not yet available in RN).
   */
  async mockRequest(urlPattern: RegExp, response: MockResponse): Promise<void> {
    const patternSource = urlPattern.source;
    const patternFlags = urlPattern.flags;
    const status = response.status ?? 200;
    const headers = response.headers ?? { 'Content-Type': 'application/json' };
    const body = JSON.stringify(response.body ?? '');

    await this.evaluate(`
      (() => {
        const _origFetch = globalThis.__origFetch || globalThis.fetch;
        globalThis.__origFetch = _origFetch;
        globalThis.fetch = function(url, opts) {
          const pattern = new RegExp(${JSON.stringify(patternSource)}, ${JSON.stringify(patternFlags)});
          if (pattern.test(String(url))) {
            return Promise.resolve(new Response(${body}, {
              status: ${status},
              headers: ${JSON.stringify(headers)},
            }));
          }
          return _origFetch(url, opts);
        };
      })()
    `);
  }

  /** Remove all fetch mocks installed by mockRequest(). */
  async clearMocks(): Promise<void> {
    await this.evaluate(`
      if (globalThis.__origFetch) {
        globalThis.fetch = globalThis.__origFetch;
        delete globalThis.__origFetch;
      }
    `);
  }

  // ─── Raw CDP access ───────────────────────────────────────────────────────

  /**
   * Access the underlying CDPSession for advanced use cases.
   */
  get cdpSession(): CDPSession {
    return this.session;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    this.session.close();
  }

  get isConnected(): boolean {
    return this.session.isConnected;
  }
}

// ─── CDP type stubs ───────────────────────────────────────────────────────────

interface RuntimeEvaluateResult {
  result: { type: string; value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: unknown };
}

interface RuntimeConsoleParams {
  type: string;
  args: ConsoleArg[];
}

interface ConsoleArg {
  type: string;
  value?: unknown;
  description?: string;
}
