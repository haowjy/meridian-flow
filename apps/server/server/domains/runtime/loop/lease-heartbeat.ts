/**
 * Renew heartbeat for `RunAuthority`. Wraps the port so both run owners share one
 * implementation: while a lease is held the adapter renews it at `ttl / 3`, and
 * `release` clears the interval before delegating. A failed renew is reported to
 * the `EventSink` and swallowed — the lease simply expires rather than crashing
 * the running turn. A renew that reports the lease lost (`false`) is reported
 * once and stops the heartbeat: the loop's signal to exit through `closeRun`.
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
  const lost = new Set<Lease>();

  function stopRenewing(lease: Lease): void {
    const timer = timers.get(lease);
    if (timer) {
      clearInterval(timer);
      timers.delete(lease);
    }
  }

  async function renew(lease: Lease): Promise<void> {
    if (lost.has(lease)) return;
    let held: boolean;
    try {
      held = await authority.renew(lease);
    } catch (error) {
      emitEvent(options.eventSink, {
        level: "warn",
        source: "runtime.run-lease",
        name: "lease.renew_failed",
        correlation: { threadId: lease.threadId, runId: lease.runId },
        payload: unknownToEventPayload(error),
      });
      return;
    }
    if (held) return;
    lost.add(lease);
    stopRenewing(lease);
    emitEvent(options.eventSink, {
      level: "warn",
      source: "runtime.run-lease",
      name: "lease.lost",
      correlation: { threadId: lease.threadId, runId: lease.runId },
      payload: {},
    });
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
      stopRenewing(lease);
      lost.delete(lease);
      await authority.release(lease);
    },

    renew: (lease) => authority.renew(lease),
    holder: (threadId) => authority.holder(threadId),
    publish: (lease, phase) => authority.publish(lease, phase),
    bindTurn: (lease, turnId, messageIds) => authority.bindTurn(lease, turnId, messageIds),
    setInboxConsumption: (lease, messageIds) => authority.setInboxConsumption(lease, messageIds),
    read: (threadId) => authority.read(threadId),
    readMany: (threadIds) => authority.readMany(threadIds),
    readRunningTurnId: (threadId) => authority.readRunningTurnId(threadId),
    cancel: (threadId) => authority.cancel(threadId),
  };
}
