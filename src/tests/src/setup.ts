/**
 * Jest global setup - configures the test environment
 */

// Global cleanup handlers
const cleanupHandlers: (() => Promise<void>)[] = [];

export function registerCleanup(handler: () => Promise<void>): void {
  cleanupHandlers.push(handler);
}

afterAll(async () => {
  for (const handler of cleanupHandlers) {
    try {
      await handler();
    } catch (error) {
      console.error("Cleanup error:", error);
    }
  }
});
