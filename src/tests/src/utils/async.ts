/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number; message?: string } = {},
): Promise<void> {
  const {
    timeout = 30000,
    interval = 100,
    message = "Condition not met",
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await sleep(interval);
  }

  throw new Error(`Timeout: ${message}`);
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function until it succeeds or reaches max attempts
 */
export async function retry<T>(
  fn: () => T | Promise<T>,
  options: { maxAttempts?: number; delay?: number; backoff?: number } = {},
): Promise<T> {
  const { maxAttempts = 3, delay = 1000, backoff = 1.5 } = options;

  let lastError: Error | null = null;
  let currentDelay = delay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      console.warn(`Attempt ${attempt}/${maxAttempts} failed:`, error);

      if (attempt < maxAttempts) {
        await sleep(currentDelay);
        currentDelay *= backoff;
      }
    }
  }

  throw lastError;
}

/**
 * Generate a unique ID for tests
 */
export function generateTestId(prefix: string = "test"): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}
