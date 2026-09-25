/** Tracks admitted HTTP handlers and gates requests once graceful shutdown starts. */
import { withDeadline } from "./process-shutdown.js";

const inFlight = new Set<object>();
const admitted = new WeakSet<object>();
const drainWaiters = new Set<() => void>();
let acceptingRequests = true;

export function trackHttpRequest(event: object): boolean {
  if (!acceptingRequests) return false;
  admitted.add(event);
  inFlight.add(event);
  return true;
}

export function isHttpRequestAdmitted(event: object): boolean {
  return admitted.has(event);
}

export function isHttpRequestAdmissionStopped(): boolean {
  return !acceptingRequests;
}

export function completeHttpRequest(event: object): void {
  if (!inFlight.delete(event) || inFlight.size !== 0) return;
  for (const resolve of drainWaiters) resolve();
  drainWaiters.clear();
}

export function stopHttpRequestAdmission(): void {
  acceptingRequests = false;
  if (inFlight.size === 0) {
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  }
}

export function inFlightHttpRequestCount(): number {
  return inFlight.size;
}

export async function waitForHttpRequestDrain(timeoutMs: number): Promise<void> {
  if (inFlight.size === 0) return;

  let onDrained: (() => void) | undefined;
  const drained = new Promise<void>((resolve) => {
    onDrained = () => resolve();
    drainWaiters.add(onDrained);
  });
  const result = await withDeadline(() => drained, Date.now() + timeoutMs);
  if (onDrained) drainWaiters.delete(onDrained);
  if (result.status === "deadline") {
    throw new Error(`Timed out waiting for ${inFlight.size} in-flight HTTP request(s).`);
  }
}
