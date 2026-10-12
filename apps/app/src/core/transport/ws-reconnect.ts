/**
 * ws-reconnect — reconnect backoff policy for the WebSocket transports.
 *
 * Defines the default backoff config and pure delay computations (jittered
 * exponential for normal attempts, fixed for persistent retries). No socket
 * state; consumed by `SocketLifecycleController`.
 */
export const DEFAULT_WS_RECONNECT = {
  maxReconnectAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitterRatio: 0.2,
  persistentDelayMs: 30_000,
};

export function computeReconnectDelayMs(
  backoff: typeof DEFAULT_WS_RECONNECT,
  attempt: number,
  random: () => number,
): number {
  const exponential = Math.min(
    backoff.maxDelayMs,
    backoff.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const jitterWindow = exponential * backoff.jitterRatio;
  const jittered = exponential + (random() * 2 - 1) * jitterWindow;
  return Math.max(0, Math.round(jittered));
}

export function computePersistentReconnectDelayMs(
  backoff: typeof DEFAULT_WS_RECONNECT,
  random: () => number,
): number {
  const jitterWindow = backoff.persistentDelayMs * backoff.jitterRatio;
  const jittered = backoff.persistentDelayMs + (random() * 2 - 1) * jitterWindow;
  return Math.max(0, Math.round(jittered));
}
