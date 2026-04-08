# metro-bridge

CDP/Metro bridge for React Native development tooling. Provides target discovery, a WebSocket CDP session, a proxy multiplexer, a high-level bridge API, DevTools launcher, and an optional app-side client SDK.

Used by [metro-mcp](https://github.com/steve228uk/metro-mcp).

## Installation

```sh
npm install metro-bridge
# or
bun add metro-bridge
```

`ws` is the only required dependency. `chrome-launcher` and `chromium-edge-launcher` are optional (needed only for `openDevTools()`).

## Usage

### MetroBridge — high-level API

The simplest way to connect to a running React Native app:

```ts
import { MetroBridge } from 'metro-bridge'

// Connect (throws if Metro is not running)
const bridge = await MetroBridge.connect(8081)

// Or connect optionally — returns null if Metro is unavailable
const bridge = await MetroBridge.tryConnect(8081)
if (!bridge) {
  console.log('Metro not running, skipping bridge features')
}

// Evaluate JavaScript in the app's Hermes context
const count = await bridge.evaluate<number>('globalThis.__itemCount')

// Wait for React Native's InteractionManager to report idle
await bridge.waitForIdle(5000)

// Capture console output
const unsub = bridge.onConsole((type, args) => {
  console.log(`[app:${type}]`, ...args)
})
unsub() // stop listening

// Mock network requests (JS-layer fetch patch)
await bridge.mockRequest(/api\.example\.com\/users/, {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify([{ id: 1, name: 'Alice' }]),
})
await bridge.clearMocks()

// Access the underlying CDPSession for advanced use
const session = bridge.cdpSession

await bridge.close()
```

### CDPSession — low-level CDP connection

```ts
import { CDPSession, MetroDiscovery } from 'metro-bridge'

const discovery = new MetroDiscovery(8081)
const targets = await discovery.discover()
const session = await CDPSession.connect(targets[0])

// Send CDP commands
const result = await session.send('Runtime.evaluate', {
  expression: '1 + 1',
  returnByValue: true,
})

// Listen for CDP events
session.on('Runtime.consoleAPICalled', (params) => {
  console.log(params)
})

await session.close()
```

### MetroDiscovery — target discovery

```ts
import { MetroDiscovery, fetchTargets, selectBestTarget, scanMetroPorts } from 'metro-bridge'

// Class API
const discovery = new MetroDiscovery(8081)
const targets = await discovery.discover()
const session = await discovery.attach() // attaches to best target
const running = await discovery.isMetroRunning()

// Standalone functions
const targets = await fetchTargets('127.0.0.1', 8081)
const best = selectBestTarget(targets) // prefers Bridgeless > Hermes > standard
const servers = await scanMetroPorts('127.0.0.1') // scans common ports

// Check if the target supports native multi-session (RN 0.85+)
if (supportsMultipleDebuggers(best)) {
  // Multiple CDPSessions can connect to Metro directly — no CDPMultiplexer needed
}
```

### CDPMultiplexer — share one Hermes connection

On **RN 0.85+**, Metro's inspector proxy supports multiple concurrent debugger
connections natively (signalled by `supportsMultipleDebuggers: true` in the
target's capabilities). In that case, Chrome DevTools and your `CDPSession` can
each connect to Metro directly — no multiplexer required.

On **RN <0.85**, only one debugger can hold the connection at a time. Use
`CDPMultiplexer` to share a single upstream connection across multiple consumers:

```ts
import {
  CDPSession, MetroDiscovery, CDPMultiplexer, openDevTools,
  selectBestTarget, supportsMultipleDebuggers,
} from 'metro-bridge'

const discovery = new MetroDiscovery(8081)
const target = selectBestTarget(await discovery.discover())

if (supportsMultipleDebuggers(target)) {
  // RN 0.85+: connect directly — DevTools and your CDPSession coexist without a proxy
  const session = await CDPSession.connect(target)
  const frontendUrl = `http://localhost:8081/debugger-frontend/rn_fusebox.html?ws=${new URL(target.webSocketDebuggerUrl).host}`
  await openDevTools(frontendUrl)
} else {
  // RN <0.85: multiplex the single upstream connection
  const session = await CDPSession.connect(target)
  const multiplexer = new CDPMultiplexer(session, {
    // Domains that your code needs and should never be disabled by external clients
    protectedDomains: ['Runtime', 'Network'],
  })
  const port = await multiplexer.start()
  const frontendUrl = `http://localhost:8081/debugger-frontend/rn_fusebox.html?ws=127.0.0.1:${port}`
  await openDevTools(frontendUrl)

  // Your code can still use the session directly
  await session.send('Runtime.evaluate', { expression: 'Date.now()', returnByValue: true })

  await multiplexer.stop()
}
```

### openDevTools

```ts
import { openDevTools } from 'metro-bridge'

const { opened, url } = await openDevTools('http://localhost:8081/debugger-frontend/rn_fusebox.html?ws=...')
if (!opened) {
  console.log('Open this URL in Chrome:', url)
}
```

## Client SDK

The `metro-bridge/client` entry provides an optional app-side SDK. Import it inside your React Native app (dev mode only) to expose state and events to your server-side tooling via `Runtime.evaluate`.

```ts
import { MetroBridgeClient } from 'metro-bridge/client'

if (__DEV__) {
  const client = new MetroBridgeClient()

  // Register custom commands callable from the server
  client.registerCommand('resetState', async ({ userId }) => {
    await store.dispatch(resetUser(userId))
    return { ok: true }
  })

  // Capture Redux actions
  client.useReduxMiddleware(store)
  // Then add the middleware to your store:
  // configureStore({ middleware: (getDefault) => getDefault().concat(store.__metroBridgeMiddleware) })

  // Track React Navigation state changes
  client.useNavigationTracking(navigationRef)

  // Track lifecycle events (foreground/background/deep links)
  client.trackLifecycle()

  // Structured logging
  client.log('auth', { event: 'login', userId: '123' })

  // Subscribe arbitrary state (Zustand, MobX, etc.)
  client.subscribeState('cart', () => cartStore.getState())

  // Performance marks
  client.mark('screen-start')
  client.measure('screen-load', 'screen-start', 'screen-ready')
}
```

### React Profiler integration

```tsx
import { Profiler } from 'react'
import { trackRender } from 'metro-bridge/client'

<Profiler id="ProductList" onRender={trackRender}>
  <ProductList />
</Profiler>
```

Render records are stored on `globalThis.__METRO_BRIDGE__.renders`.

### Tree-shakeable imports

All pieces of the client SDK can be imported individually:

```ts
import {
  registerCommand,
  createReduxMiddleware,
  createNavigationTracking,
  LifecycleTracker,
  StructuredLogger,
  StateSubscriptionManager,
  PerformanceTracker,
  trackRender,
  ClientBuffer,
} from 'metro-bridge/client'
```

## License

MIT
