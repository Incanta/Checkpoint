// Tracks request activity so an ephemeral daemon can shut itself down after a
// period of inactivity. The resident daemon never reads these values; the
// tRPC activity middleware always records, which is cheap.

let lastActivityMs = Date.now();
let inFlight = 0;

/** Call when a request begins. */
export function recordActivityStart(): void {
  inFlight++;
  lastActivityMs = Date.now();
}

/** Call when a request completes (success or error). */
export function recordActivityEnd(): void {
  inFlight = Math.max(0, inFlight - 1);
  lastActivityMs = Date.now();
}

/** Epoch ms of the most recent request start or end. */
export function getLastActivityMs(): number {
  return lastActivityMs;
}

/** Number of requests currently being handled. */
export function getInFlight(): number {
  return inFlight;
}
