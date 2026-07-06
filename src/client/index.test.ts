import { afterEach, describe, expect, test } from 'bun:test';
import { MetroBridgeClient, type MetroBridgeGlobal } from './index.js';
import type { NavigationEvent, NavigationRef } from './middleware/navigation.js';
import type { createReduxMiddleware, ReduxAction, ReduxStore } from './middleware/redux.js';

type ReduxMiddleware = ReturnType<typeof createReduxMiddleware>['middleware'];

declare global {
  var __METRO_BRIDGE__: MetroBridgeGlobal | undefined;
}

afterEach(() => {
  delete globalThis.__METRO_BRIDGE__;
});

function createNavigationRef(): NavigationRef & { emitStateChange(): void } {
  let stateHandler: ((event: unknown) => void) | undefined;

  return {
    current: {
      getRootState: () => ({
        index: 0,
        routes: [{ name: 'Home', params: { tab: 'main' } }],
      }),
    },
    addListener: (event, handler) => {
      if (event === 'state') {
        stateHandler = handler;
      }

      return () => {
        stateHandler = undefined;
      };
    },
    emitStateChange: () => {
      stateHandler?.({ type: 'state' });
    },
  };
}

function createReduxStore(): ReduxStore {
  return {
    getState: () => ({ user: { id: '123' } }),
    dispatch: (action) => action,
  };
}

function getBridgeGlobal(): MetroBridgeGlobal {
  const bridge = globalThis.__METRO_BRIDGE__;
  if (!bridge) throw new Error('Expected metro bridge global to be registered');

  return bridge;
}

function getNavigation(): NonNullable<MetroBridgeGlobal['navigation']> {
  const navigation = getBridgeGlobal().navigation;
  if (!navigation) throw new Error('Expected navigation tracking to be registered');

  return navigation;
}

function getRedux(): NonNullable<MetroBridgeGlobal['redux']> {
  const redux = getBridgeGlobal().redux;
  if (!redux) throw new Error('Expected redux instrumentation to be registered');

  return redux;
}

describe('MetroBridgeClient compiler-safe aliases', () => {
  test('trackNavigation registers navigation state tracking', () => {
    const client = new MetroBridgeClient();
    const navigationRef = createNavigationRef();

    client.trackNavigation(navigationRef);
    navigationRef.emitStateChange();

    const navigation = getNavigation();
    expect(navigation.getState()).toEqual({
      index: 0,
      routes: [{ name: 'Home', params: { tab: 'main' } }],
    });
    expect(navigation.events.getAll()).toEqual([
      {
        timestamp: expect.any(Number),
        type: 'state_change',
        routeName: 'Home',
        params: { tab: 'main' },
      } satisfies NavigationEvent,
    ]);
  });

  test('useNavigationTracking remains backward-compatible', () => {
    const client = new MetroBridgeClient();
    const navigationRef = createNavigationRef();

    client.useNavigationTracking(navigationRef);
    navigationRef.emitStateChange();

    expect(getNavigation().events.getAll()).toHaveLength(1);
  });

  test('wireReduxStore registers redux instrumentation', () => {
    const client = new MetroBridgeClient();
    const store = createReduxStore();

    client.wireReduxStore(store);

    expect(store.__metroBridgeMiddleware).toEqual(expect.any(Function));
    const redux = getRedux();
    expect(redux.getState()).toEqual({ user: { id: '123' } });
    expect(redux.dispatch({ type: 'TEST' })).toEqual({ type: 'TEST' });

    const middleware = store.__metroBridgeMiddleware as ReduxMiddleware;
    middleware({ getState: store.getState })((action) => action)({
      type: 'cart/add',
      payload: { sku: 'ABC' },
    });

    expect(redux.actions.getAll()).toEqual([
      {
        type: 'cart/add',
        timestamp: expect.any(Number),
        payload: { sku: 'ABC' },
        duration: expect.any(Number),
      } satisfies ReduxAction,
    ]);
  });

  test('useReduxMiddleware remains backward-compatible', () => {
    const client = new MetroBridgeClient();
    const store = createReduxStore();

    client.useReduxMiddleware(store);

    expect(store.__metroBridgeMiddleware).toEqual(expect.any(Function));
    expect(getRedux().getState()).toEqual({ user: { id: '123' } });
  });

  test('getReduxMiddleware errors before wiring and succeeds after wiring', () => {
    const client = new MetroBridgeClient();

    expect(() => client.getReduxMiddleware()).toThrow('Call wireReduxStore(store) first');

    client.wireReduxStore(createReduxStore());

    expect(client.getReduxMiddleware()).toBe(getRedux().actions);
  });
});
