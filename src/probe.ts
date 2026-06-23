import { CDPSession } from './session.js';
import type { CDPProbeResult, MetroTarget } from './types.js';

export interface CDPProbeOptions {
  method?: string;
  timeoutMs?: number;
}

const DEFAULT_PROBE_METHOD = 'Schema.getDomains';
const DEFAULT_PROBE_TIMEOUT_MS = 1000;

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function probeCDPConnection(
  target: MetroTarget,
  options: CDPProbeOptions = {},
): Promise<CDPProbeResult> {
  const method = options.method ?? DEFAULT_PROBE_METHOD;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const startedAt = Date.now();
  const session = new CDPSession();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  try {
    const probe = session.connectToTarget(target)
      .then(() => session.send(method))
      .then(() => 'ok' as const)
      .catch((error) => {
        if (timedOut) return 'ignored' as const;
        throw error;
      });
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve('timeout');
      }, timeoutMs);
    });

    const result = await Promise.race([probe, timeoutPromise]);
    if (result === 'timeout') {
      return {
        ok: false,
        reason: 'timeout',
        method,
        durationMs: elapsedSince(startedAt),
        closeInfo: session.getLastCloseInfo() ?? undefined,
      };
    }

    return {
      ok: true,
      method,
      durationMs: elapsedSince(startedAt),
    };
  } catch (error) {
    const closeInfo = session.getLastCloseInfo();
    return {
      ok: false,
      reason: closeInfo?.wasConnected ? 'closed' : 'error',
      method,
      durationMs: elapsedSince(startedAt),
      closeInfo: closeInfo ?? undefined,
      error: errorMessage(error),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    session.disconnect();
  }
}
