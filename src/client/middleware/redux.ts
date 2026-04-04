import { ClientBuffer } from '../buffer.js';

export interface ReduxStore {
  getState(): unknown;
  dispatch(action: unknown): unknown;
  __metroBridgeMiddleware?: unknown;
}

export interface ReduxAction {
  type: string;
  timestamp: number;
  payload?: unknown;
  duration?: number;
}

export function createReduxMiddleware() {
  const actions = new ClientBuffer<ReduxAction>(200);

  const middleware =
    (_store: { getState: () => unknown }) =>
    (next: (action: unknown) => unknown) =>
    (action: unknown) => {
      const start = Date.now();
      const actionObj = action as Record<string, unknown>;

      const entry: ReduxAction = {
        type: (actionObj?.type as string) || 'UNKNOWN',
        timestamp: start,
        payload: actionObj?.payload,
      };

      const result = next(action);
      entry.duration = Date.now() - start;
      actions.push(entry);

      return result;
    };

  return { middleware, actions };
}
