/**
 * Target info returned by Metro's /json endpoint.
 */
export interface MetroTarget {
  id: string;
  title: string;
  description: string;
  type: string;
  devtoolsFrontendUrl?: string;
  webSocketDebuggerUrl: string;
  faviconUrl?: string;
  url?: string;
  deviceName?: string;
  reactNative?: {
    logicalDeviceId?: string;
    capabilities?: {
      nativePageReloads?: boolean;
      nativeSourceCodeFetching?: boolean;
      /** true = New Architecture / Fusebox inspector (RN <0.85) */
      prefersFuseboxFrontend?: boolean;
      /** true = RN 0.85+ — Metro handles multiple concurrent debugger sessions natively */
      supportsMultipleDebuggers?: boolean;
    };
  };
  vm?: string;
}

export interface CDPCloseInfo {
  code: number;
  reason: string;
  wasConnected: boolean;
}

export type CDPProbeFailureReason = 'closed' | 'timeout' | 'error';

export type CDPProbeResult =
  | {
      ok: true;
      method: string;
      durationMs: number;
    }
  | {
      ok: false;
      reason: CDPProbeFailureReason;
      method: string;
      durationMs: number;
      closeInfo?: CDPCloseInfo;
      error?: string;
    };

/**
 * CDP message sent to the debugger.
 */
export interface CDPRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * CDP response from the debugger.
 */
export interface CDPResponse {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Discovered Metro server info.
 */
export interface MetroServerInfo {
  host: string;
  port: number;
  targets: MetroTarget[];
}

export type ConsoleHandler = (type: string, args: unknown[]) => void;

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}
