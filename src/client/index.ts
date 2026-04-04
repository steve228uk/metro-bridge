/**
 * metro-bridge Client SDK
 *
 * Optional dev-mode integration for enhanced app instrumentation.
 * All features register on globalThis.__METRO_BRIDGE__ which the server
 * discovers via Runtime.evaluate.
 *
 * Usage:
 *   import { MetroBridgeClient } from 'metro-bridge/client';
 *
 *   if (__DEV__) {
 *     const bridge = new MetroBridgeClient();
 *     bridge.registerCommand('login', async ({ email, password }) => { ... });
 *     bridge.useReduxMiddleware(store);
 *     bridge.useNavigationTracking(navigationRef);
 *   }
 */

import { createReduxMiddleware, type ReduxStore } from './middleware/redux.js';
import { createNavigationTracking, type NavigationRef } from './middleware/navigation.js';
import { PerformanceTracker } from './performance.js';
import { StructuredLogger } from './logger.js';
import { StateSubscriptionManager } from './state.js';
import { LifecycleTracker } from './lifecycle.js';
import { ClientBuffer } from './buffer.js';

export interface MetroBridgeGlobal {
  commands: Record<string, (params: Record<string, unknown>) => unknown>;
  redux?: {
    actions: ClientBuffer<unknown>;
    getState: () => unknown;
    dispatch: (action: unknown) => unknown;
  };
  navigation?: {
    events: ClientBuffer<unknown>;
    getState: () => unknown;
  };
  performance?: {
    marks: Map<string, number>;
    measures: Array<{ name: string; startMark: string; endMark: string; duration: number }>;
  };
  logs?: {
    channels: Map<string, ClientBuffer<unknown>>;
  };
  state?: {
    subscriptions: Map<string, () => unknown>;
  };
  lifecycle?: {
    events: ClientBuffer<unknown>;
  };
  renders?: unknown[];
  clearRenders?: () => void;
}

export class MetroBridgeClient {
  private bridgeGlobal: MetroBridgeGlobal;
  private performance: PerformanceTracker;
  private logger: StructuredLogger;
  private stateManager: StateSubscriptionManager;
  private lifecycleTracker: LifecycleTracker;

  constructor() {
    this.performance = new PerformanceTracker();
    this.logger = new StructuredLogger();
    this.stateManager = new StateSubscriptionManager();
    this.lifecycleTracker = new LifecycleTracker();

    this.bridgeGlobal = {
      commands: {},
      performance: { marks: this.performance.marks, measures: this.performance.measures },
      logs: { channels: this.logger.channels },
      state: { subscriptions: this.stateManager.subscriptions },
    };

    (globalThis as Record<string, unknown>).__METRO_BRIDGE__ = this.bridgeGlobal;
  }

  // ── Custom Commands ──────────────────────────────────────────────────────

  registerCommand(name: string, handler: (params: Record<string, unknown>) => unknown): void {
    this.bridgeGlobal.commands[name] = handler;
  }

  // ── Redux ────────────────────────────────────────────────────────────────

  useReduxMiddleware(store: ReduxStore): void {
    const { middleware, actions } = createReduxMiddleware();
    this.bridgeGlobal.redux = {
      actions,
      getState: () => store.getState(),
      dispatch: (action: unknown) => store.dispatch(action),
    };
    store.__metroBridgeMiddleware = middleware;
  }

  getReduxMiddleware(): unknown {
    if (!this.bridgeGlobal.redux) {
      throw new Error('Call useReduxMiddleware(store) first');
    }
    return (this.bridgeGlobal.redux as unknown as { actions: ClientBuffer<unknown> }).actions;
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  useNavigationTracking(navigationRef: NavigationRef): void {
    const { events, getState } = createNavigationTracking(navigationRef);
    this.bridgeGlobal.navigation = { events, getState };
  }

  // ── Performance ──────────────────────────────────────────────────────────

  mark(name: string): void {
    this.performance.mark(name);
  }

  measure(name: string, startMark: string, endMark: string): number | null {
    return this.performance.measure(name, startMark, endMark);
  }

  // ── Structured Logging ───────────────────────────────────────────────────

  log(channel: string, data: unknown): void {
    this.logger.log(channel, data);
  }

  // ── State Subscriptions ──────────────────────────────────────────────────

  subscribeState(name: string, getter: () => unknown): void {
    this.stateManager.subscribe(name, getter);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  trackLifecycle(): void {
    this.bridgeGlobal.lifecycle = { events: this.lifecycleTracker.events };
    this.lifecycleTracker.start();
  }
}

// Tree-shakeable named exports
export { createReduxMiddleware } from './middleware/redux.js';
export { createNavigationTracking } from './middleware/navigation.js';
export { PerformanceTracker, trackRender } from './performance.js';
export type { RenderRecord } from './performance.js';
export { StructuredLogger } from './logger.js';
export { StateSubscriptionManager } from './state.js';
export { LifecycleTracker } from './lifecycle.js';
export { ClientBuffer } from './buffer.js';

/**
 * Register a command without creating a full client instance.
 */
export function registerCommand(
  name: string,
  handler: (params: Record<string, unknown>) => unknown,
): void {
  const g = globalThis as Record<string, unknown>;
  if (!g.__METRO_BRIDGE__) {
    g.__METRO_BRIDGE__ = { commands: {} };
  }
  const bridge = g.__METRO_BRIDGE__ as MetroBridgeGlobal;
  if (!bridge.commands) bridge.commands = {};
  bridge.commands[name] = handler;
}
