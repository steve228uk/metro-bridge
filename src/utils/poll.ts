export class TimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TimeoutError';
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Polls `fn` every `interval` ms until it returns a non-null value or `timeout` elapses.
 */
export async function poll<T>(
  fn: () => Promise<T | null | undefined>,
  timeout = 10_000,
  interval = 100,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== null && result !== undefined) return result;
    } catch (e) {
      lastError = e;
    }
    await sleep(Math.min(interval, deadline - Date.now()));
  }

  const cause = lastError instanceof Error ? lastError : undefined;
  throw new TimeoutError(
    `Timed out after ${timeout}ms waiting for condition${cause ? `: ${cause.message}` : ''}`,
    { cause },
  );
}
