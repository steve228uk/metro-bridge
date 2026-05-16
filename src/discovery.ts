import type { MetroTarget, MetroServerInfo } from './types.js';
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

/**
 * Select the best target from a list.
 * Priority: Bridgeless > Hermes > standard RN (skips Reanimated/Experimental).
 */
export function selectBestTarget(targets: MetroTarget[]): MetroTarget | null {
  // Only consider targets that expose a CDP debugger endpoint
  const debuggable = targets.filter((t) => t.webSocketDebuggerUrl);
  if (debuggable.length === 0) return null;

  const filtered = debuggable.filter(
    (t) => !t.title.includes('Reanimated') && !t.title.includes('Experimental'),
  );

  if (filtered.length === 0) return debuggable[0];

  const bridgeless = filtered.find(
    (t) => t.title.includes('Bridgeless') || t.title.includes('React Native Bridge-less'),
  );
  if (bridgeless) return bridgeless;

  const hermes = filtered.find(
    (t) => t.title.includes('Hermes') || t.vm === 'Hermes',
  );
  if (hermes) return hermes;

  return filtered[0];
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
 * Returns true if the target is running on RN 0.85+ and Metro's inspector
 * proxy supports native multi-session. When true, multiple CDPSessions
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
