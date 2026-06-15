/**
 * ws-reconnect — reconnect backoff policy for the WebSocket transports.
 *
 * Defines the default backoff config and pure delay computations (jittered
 * exponential for normal attempts, fixed for persistent retries). No socket
 * state; consumed by `WsThreadTransport` and `DocumentSessionTransport`.
 */
export type WsReconnectBackoffConfig = {
  maxReconnectAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  persistentDelayMs?: number;
};

export const DEFAULT_WS_RECONNECT: Required<WsReconnectBackoffConfig> = {
  maxReconnectAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitterRatio: 0.2,
  persistentDelayMs: 30_000,
};

export function resolveWsReconnectBackoff(
  config: WsReconnectBackoffConfig = {},
): Required<WsReconnectBackoffConfig> {
  return {
    maxReconnectAttempts: config.maxReconnectAttempts ?? DEFAULT_WS_RECONNECT.maxReconnectAttempts,
    baseDelayMs: config.baseDelayMs ?? DEFAULT_WS_RECONNECT.baseDelayMs,
    maxDelayMs: config.maxDelayMs ?? DEFAULT_WS_RECONNECT.maxDelayMs,
    jitterRatio: config.jitterRatio ?? DEFAULT_WS_RECONNECT.jitterRatio,
    persistentDelayMs: config.persistentDelayMs ?? DEFAULT_WS_RECONNECT.persistentDelayMs,
  };
}

export function computeReconnectDelayMs(
  backoff: Required<WsReconnectBackoffConfig>,
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
  backoff: Required<WsReconnectBackoffConfig>,
  random: () => number,
): number {
  const jitterWindow = backoff.persistentDelayMs * backoff.jitterRatio;
  const jittered = backoff.persistentDelayMs + (random() * 2 - 1) * jitterWindow;
  return Math.max(0, Math.round(jittered));
}
