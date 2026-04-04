import fs from 'fs';
import { createLogger } from './utils/logger.js';

const logger = createLogger('devtools');

const DEFAULT_STATE_FILE = '/tmp/metro-bridge-devtools.json';

async function findBrowserPath(): Promise<string | null> {
  try {
    const { Launcher } = await import('chrome-launcher');
    const path = Launcher.getFirstInstallation();
    if (path) return path;
  } catch {}

  try {
    const { Launcher: EdgeLauncher } = await import('chromium-edge-launcher');
    const path = EdgeLauncher.getFirstInstallation();
    if (path) return path;
  } catch {}

  return null;
}

async function tryFocusExisting(frontendUrl: string, stateFile: string): Promise<boolean> {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!state.pid || !state.remoteDebuggingPort) return false;

    try { process.kill(state.pid, 0); } catch { return false; }

    const resp = await fetch(`http://localhost:${state.remoteDebuggingPort}/json`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!resp.ok) return false;

    const targets = await resp.json() as Array<{ id: string; url: string }>;
    const target = targets.find(t => t.url?.includes('rn_fusebox') || t.url === frontendUrl);
    if (!target?.id) return false;

    const activate = await fetch(
      `http://localhost:${state.remoteDebuggingPort}/json/activate/${target.id}`,
      { signal: AbortSignal.timeout(1000) },
    );
    return activate.ok;
  } catch {
    return false;
  }
}

async function launchBrowser(frontendUrl: string, stateFile: string): Promise<void> {
  const { launch } = await import('chrome-launcher');
  const chrome = await launch({
    chromeFlags: [`--app=${frontendUrl}`, '--window-size=1200,600'],
  });
  chrome.process.unref();
  try {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ pid: chrome.pid, remoteDebuggingPort: chrome.port }),
    );
  } catch (err) {
    logger.warn('Failed to write devtools state:', err);
  }
}

/**
 * Open a URL in Chrome or Edge as a DevTools app window.
 * If a DevTools window is already open for this URL, focuses it instead.
 *
 * @param frontendUrl - The DevTools frontend URL to open
 * @param options.stateFile - Path to store Chrome process state (default: /tmp/metro-bridge-devtools.json)
 * @returns Whether the browser was opened, and the URL
 */
export async function openDevTools(
  frontendUrl: string,
  options?: { stateFile?: string },
): Promise<{ opened: boolean; url: string }> {
  const stateFile = options?.stateFile ?? DEFAULT_STATE_FILE;
  const browserPath = await findBrowserPath();

  if (browserPath) {
    try {
      const focused = await tryFocusExisting(frontendUrl, stateFile);
      if (!focused) {
        await launchBrowser(frontendUrl, stateFile);
      }
      return { opened: true, url: frontendUrl };
    } catch (err) {
      logger.debug('Failed to open DevTools:', err);
    }
  } else {
    logger.debug('No Chrome/Edge installation found');
  }

  return { opened: false, url: frontendUrl };
}
