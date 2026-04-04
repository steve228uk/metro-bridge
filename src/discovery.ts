import type { MetroTarget, MetroServerInfo } from './types.js';
import { CDPSession } from './session.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('discovery');

const DEFAULT_PORTS = [8081, 8082, 19000, 19001, 19002];

/**
 * Fetch debuggable targets from a Metro server's /json endpoint.
 */
export async function fetchTargets(host: string, port: number): Promise<MetroTarget[]> {
  try {
    const url = `http://${host}:${port}/json`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];
    const targets = (await response.json()) as MetroTarget[];
    return targets.filter((t) => t.webSocketDebuggerUrl);
  } catch {
    return [];
  }
}

/**
 * Select the best target from a list.
 * Priority: Bridgeless > Hermes > standard RN (skips Reanimated/Experimental).
 */
export function selectBestTarget(targets: MetroTarget[]): MetroTarget | null {
  if (targets.length === 0) return null;

  const filtered = targets.filter(
    (t) => !t.title.includes('Reanimated') && !t.title.includes('Experimental'),
  );

  if (filtered.length === 0) return targets[0];

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
    const targets = await fetchTargets(host, port);
    if (targets.length > 0) {
      results.push({ host, port, targets });
      logger.info(`Found Metro server on port ${port} with ${targets.length} target(s)`);
    }
  }));

  return results;
}

/**
 * Check if Metro is running on the given host/port.
 */
export async function checkMetroStatus(host: string, port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://${host}:${port}/status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) return await response.text();
    return null;
  } catch {
    return null;
  }
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
