/**
 * Renew heartbeat for `RunAuthority`. Wraps the port so both run owners share one
 * implementation: while a lease is held the adapter renews it at `ttl / 3`, and
 * `release` clears the interval before delegating. A failed renew is reported to
 * the `EventSink` and swallowed — the lease simply expires rather than crashing
 * the running turn.
 */
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { DEFAULT_LEASE_TTL_MS, type Lease, type RunAuthority } from "./ports.js";

export interface HeartbeatRunAuthorityOptions {
  eventSink: EventSink;
  /** Lease lifetime the wrapped adapter uses; the heartbeat fires at a third. */
  leaseTtlMs?: number;
}

export function createHeartbeatRunAuthority(
  authority: RunAuthority,
  options: HeartbeatRunAuthorityOptions,
): RunAuthority {
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const renewIntervalMs = Math.max(1, Math.floor(leaseTtlMs / 3));
  const timers = new Map<Lease, ReturnType<typeof setInterval>>();

  async function renew(lease: Lease): Promise<void> {
    try {
      await authority.renew(lease);
    } catch (error) {
      emitEvent(options.eventSink, {
        level: "warn",
        source: "runtime.run-lease",
        name: "lease.renew_failed",
        correlation: { threadId: lease.threadId, runId: lease.runId },
        payload: unknownToEventPayload(error),
      });
    }
  }

  return {
    async acquire(threadId, runId) {
      const lease = await authority.acquire(threadId, runId);
      if (!lease) return null;
      const timer = setInterval(() => void renew(lease), renewIntervalMs);
      timer.unref?.();
      timers.set(lease, timer);
      return lease;
    },

    async release(lease) {
      const timer = timers.get(lease);
      if (timer) {
        clearInterval(timer);
        timers.delete(lease);
      }
      await authority.release(lease);
    },

    renew: (lease) => authority.renew(lease),
    holder: (threadId) => authority.holder(threadId),
    publish: (lease, phase) => authority.publish(lease, phase),
    read: (threadId) => authority.read(threadId),
    cancel: (threadId) => authority.cancel(threadId),
  };
}
