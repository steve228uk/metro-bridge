import type {
  MetroTarget,
  MetroServerInfo,
  MetroTargetClassification,
} from './types.js';
import { CDPSession } from './session.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('discovery');

const DEFAULT_PORTS = [8081, 8082, 19000, 19001, 19002];
const LOCALHOST_FALLBACK_HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 3000;

type HostResult<T> = {
  host: string;
  result: T;
};

function metroUrl(host: string, port: number, path: string): string {
  return `http://${host}:${port}${path}`;
}

function toHostResult<T>(host: string, result: T | null): HostResult<T> | null {
  return result === null ? null : { host, result };
}

async function withLocalhostFallback<T>(
  host: string,
  fetchFromHost: (resolvedHost: string) => Promise<T | null>,
): Promise<HostResult<T> | null> {
  try {
    return toHostResult(host, await fetchFromHost(host));
  } catch {
    if (host.toLowerCase() !== 'localhost') {
      return null;
    }
  }

  try {
    return toHostResult(
      LOCALHOST_FALLBACK_HOST,
      await fetchFromHost(LOCALHOST_FALLBACK_HOST),
    );
  } catch {
    return null;
  }
}

async function fetchTargetsWithHost(
  host: string,
  port: number,
): Promise<HostResult<MetroTarget[]> | null> {
  return withLocalhostFallback(host, async (resolvedHost) => {
    const response = await fetch(metroUrl(resolvedHost, port, '/json'), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as MetroTarget[];
  });
}

/**
 * Fetch debuggable targets from a Metro server's /json endpoint.
 */
export async function fetchTargets(host: string, port: number): Promise<MetroTarget[]> {
  return (await fetchTargetsWithHost(host, port))?.result ?? [];
}

function isSyntheticReloadTarget(target: MetroTarget): boolean {
  const identity = `${target.title} ${target.description} ${target.vm ?? ''}`.toLowerCase();
  if (
    identity.includes('experimental') &&
    (identity.includes('reload') || identity.includes("don't use"))
  ) {
    return true;
  }

  if (target.id === '-1' || target.id.endsWith('--1')) return true;

  try {
    const page = new URL(target.webSocketDebuggerUrl!).searchParams.get('page');
    return page !== null && /^-\d+$/.test(page);
  } catch {
    return false;
  }
}

function identifiesReactNativeApp(target: MetroTarget): boolean {
  const identity = `${target.title} ${target.description}`.toLowerCase();
  return (
    identity.includes('react native') ||
    identity.includes('react-native') ||
    identity.includes('bridgeless') ||
    identity.includes('bridge-less')
  );
}

function identifiesAuxiliaryRuntime(target: MetroTarget): boolean {
  const identity = `${target.title} ${target.description} ${target.vm ?? ''}`.toLowerCase();
  return (
    identity.includes('worklet') ||
    identity.includes('reanimated') ||
    identity.includes('ui runtime') ||
    identity.includes('experimental')
  );
}

/**
 * Classify whether a Metro inspector target is safe to attach to as the app
 * runtime. Classification is deliberately allowlist-based: auxiliary Hermes
 * runtimes and worklets can expose fully functional CDP URLs too.
 */
export function classifyMetroTarget(
  target: MetroTarget,
): MetroTargetClassification {
  if (!target.webSocketDebuggerUrl) {
    return { attachable: false, reason: 'missing-debugger-url' };
  }
  if (isSyntheticReloadTarget(target)) {
    return { attachable: false, reason: 'synthetic-reload-target' };
  }
  if (identifiesAuxiliaryRuntime(target)) {
    return { attachable: false, reason: 'auxiliary-runtime' };
  }
  if (
    target.reactNative?.capabilities?.nativePageReloads === true ||
    identifiesReactNativeApp(target)
  ) {
    return { attachable: true };
  }
  return { attachable: false, reason: 'auxiliary-runtime' };
}

function targetPriority(target: MetroTarget): number {
  if (target.reactNative?.capabilities?.nativePageReloads === true) return 3;
  const identity = `${target.title} ${target.description}`.toLowerCase();
  if (identity.includes('bridgeless') || identity.includes('bridge-less')) {
    return 2;
  }
  return 1;
}

/**
 * Select the best attachable app runtime from a list.
 * Priority: modern native-page targets > legacy Bridgeless > legacy RN.
 */
export function selectBestTarget(targets: MetroTarget[]): MetroTarget | null {
  let best: MetroTarget | null = null;
  let bestPriority = 0;
  for (const target of targets) {
    if (!classifyMetroTarget(target).attachable) continue;
    const priority = targetPriority(target);
    if (priority > bestPriority) {
      best = target;
      bestPriority = priority;
    }
  }
  return best;
}

/**
 * Scan common Metro ports and find running servers.
 */
export async function scanMetroPorts(
  host: string,
  specificPort?: number,
): Promise<MetroServerInfo[]> {
  const ports = specificPort ? [specificPort] : DEFAULT_PORTS;
  const results: MetroServerInfo[] = [];

  await Promise.all(ports.map(async (port) => {
    const server = await fetchTargetsWithHost(host, port);
    if (server && server.result.length > 0) {
      results.push({ host: server.host, port, targets: server.result });
      logger.info(
        `Found Metro server on ${server.host}:${port} with ${server.result.length} target(s)`,
      );
    }
  }));

  return results;
}

/**
 * Returns true if the target advertises RN 0.85+ native multi-session support.
 * Treat this as advisory: callers that depend on CDP should still probe the
 * target before skipping compatibility fallbacks. When reliable, multiple CDPSessions
 * (e.g. metro-bridge + Chrome DevTools) can connect to Metro concurrently
 * without a CDPMultiplexer.
 *
 * Note: the presence of `prefersFuseboxFrontend` or `devtoolsFrontendUrl`
 * does NOT imply multiple debugger support. Fusebox is used in RN <0.85
 * (New Architecture / Bridgeless) but still enforces a single debugger
 * connection. Only the explicit `supportsMultipleDebuggers` capability,
 * added in RN 0.85, enables concurrent connections natively.
 */
export function supportsMultipleDebuggers(target: MetroTarget): boolean {
  return target.reactNative?.capabilities?.supportsMultipleDebuggers === true;
}

/**
 * Check if Metro is running on the given host/port.
 */
export async function checkMetroStatus(host: string, port: number): Promise<string | null> {
  const server = await withLocalhostFallback(host, async (resolvedHost) => {
    const response = await fetch(metroUrl(resolvedHost, port, '/status'), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) return await response.text();
    return null;
  });

  return server?.result ?? null;
}

/**
 * Discovers debuggable targets from Metro's inspector API and
 * attaches CDP sessions.
 *
 * Metro exposes:
 *   GET http://<host>:<port>/json  → list of targets
 */
export class MetroDiscovery {
  private readonly host: string;

  constructor(
    private readonly port: number = 8081,
    host = '127.0.0.1',
  ) {
    this.host = host;
  }

  /**
   * Query Metro for connected debuggable targets.
   */
  async discover(): Promise<MetroTarget[]> {
    return fetchTargets(this.host, this.port);
  }

  /**
   * Attach to a target and return a CDPSession.
   * If no target is provided, uses the best available target.
   */
  async attach(target?: MetroTarget): Promise<CDPSession> {
    const resolved = target ?? selectBestTarget(await this.discover());
    if (!resolved) {
      throw new Error(
        `No debuggable targets found on Metro port ${this.port}.\n` +
        'Make sure Metro is running and the app is open in dev mode.',
      );
    }
    return CDPSession.connect(resolved);
  }

  /**
   * Probe whether Metro is reachable on the configured port.
   */
  async isMetroRunning(): Promise<boolean> {
    const status = await checkMetroStatus(this.host, this.port);
    return status !== null;
  }
}
