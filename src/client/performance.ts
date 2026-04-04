export interface RenderRecord {
  id: string;
  phase: 'mount' | 'update' | 'nested-update';
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}

const MAX_RENDERS = 200;

interface BridgeGlobal {
  renders?: RenderRecord[];
  clearRenders?: () => void;
}

function getOrInitRenders(): { renders: RenderRecord[]; clearRenders: () => void } {
  const g = globalThis as Record<string, unknown>;
  if (!g.__METRO_BRIDGE__) g.__METRO_BRIDGE__ = {};
  const bridge = g.__METRO_BRIDGE__ as BridgeGlobal;
  if (!bridge.renders) {
    const renders: RenderRecord[] = [];
    const clearRenders = () => { renders.length = 0; };
    bridge.renders = renders;
    bridge.clearRenders = clearRenders;
  }
  return { renders: bridge.renders!, clearRenders: bridge.clearRenders! };
}

/**
 * Drop-in onRender callback for React's <Profiler> component.
 *
 * Usage:
 *   import { trackRender } from 'metro-bridge/client';
 *   <Profiler id="sidebar" onRender={trackRender}>
 *     <Sidebar />
 *   </Profiler>
 */
export function trackRender(
  id: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number,
): void {
  const { renders } = getOrInitRenders();
  renders.push({ id, phase, actualDuration, baseDuration, startTime, commitTime });
  if (renders.length > MAX_RENDERS) renders.splice(0, renders.length - MAX_RENDERS);
}

export interface PerformanceMeasure {
  name: string;
  startMark: string;
  endMark: string;
  duration: number;
}

export class PerformanceTracker {
  marks = new Map<string, number>();
  measures: PerformanceMeasure[] = [];

  mark(name: string): void {
    this.marks.set(name, Date.now());
  }

  measure(name: string, startMark: string, endMark: string): number | null {
    const start = this.marks.get(startMark);
    const end = this.marks.get(endMark);
    if (start === undefined || end === undefined) return null;

    const duration = end - start;
    this.measures.push({ name, startMark, endMark, duration });

    if (this.measures.length > 100) {
      this.measures = this.measures.slice(-100);
    }

    return duration;
  }

  getMeasures(): PerformanceMeasure[] {
    return [...this.measures];
  }

  clear(): void {
    this.marks.clear();
    this.measures = [];
  }
}
