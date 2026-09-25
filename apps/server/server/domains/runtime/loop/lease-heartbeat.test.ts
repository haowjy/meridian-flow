/** Unit coverage for the RunAuthority renew heartbeat: cadence, stop, and failure reporting. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createHeartbeatRunAuthority } from "./lease-heartbeat.js";
import type { Lease, RunAuthority, ThreadStatus } from "./ports.js";

const THREAD_A = "00000000-0000-4000-8000-0000000000c1" as ThreadId;

function required<T>(value: T | null): T {
  if (value === null) throw new Error("expected a value");
  return value;
}

function recordingAuthority(): {
  authority: RunAuthority;
  state: { renewals: number; releases: number };
} {
  const state = { renewals: 0, releases: 0 };
  const authority: RunAuthority = {
    async acquire(threadId, runId): Promise<Lease> {
      return { threadId, runId, holderId: "holder-1" };
    },
    async renew() {
      state.renewals += 1;
      return true;
    },
    async holder() {
      return null;
    },
    async publish() {},
    async bindTurn() {},
    async setInboxConsumption() {
      return true;
    },
    async read(): Promise<ThreadStatus> {
      return { kind: "asleep" };
    },
    async readRunningTurnId() {
      return null;
    },
    async readMany() {
      return new Map();
    },
    async cancel() {
      return false;
    },
    async release() {
      state.releases += 1;
    },
  };
  return { authority, state };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RunAuthority heartbeat", () => {
  it("renews at a third of the lease TTL and stops on release", async () => {
    vi.useFakeTimers();
    const { authority, state } = recordingAuthority();
    const heartbeat = createHeartbeatRunAuthority(authority, {
      eventSink: createInMemoryEventSink(),
      leaseTtlMs: 30_000,
    });
    const lease = required(await heartbeat.acquire(THREAD_A, "run-1"));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(state.renewals).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.renewals).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.renewals).toBe(2);

    await heartbeat.release(lease);
    expect(state.releases).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.renewals).toBe(2);
  });

  it("never starts a heartbeat when the lease is not acquired", async () => {
    vi.useFakeTimers();
    const renewals: number[] = [];
    const authority: RunAuthority = {
      async acquire() {
        return null;
      },
      async renew() {
        renewals.push(1);
        return true;
      },
      async holder() {
        return null;
      },
      async publish() {},
      async bindTurn() {},
      async setInboxConsumption() {
        return true;
      },
      async read() {
        return { kind: "asleep" };
      },
      async readRunningTurnId() {
        return null;
      },
      async readMany() {
        return new Map();
      },
      async cancel() {
        return false;
      },
      async release() {},
    };
    const heartbeat = createHeartbeatRunAuthority(authority, {
      eventSink: createInMemoryEventSink(),
      leaseTtlMs: 3_000,
    });

    expect(await heartbeat.acquire(THREAD_A, "run-1")).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewals).toHaveLength(0);
  });

  it("reports a failed renew to the sink without throwing", async () => {
    vi.useFakeTimers();
    const eventSink = createInMemoryEventSink();
    const authority: RunAuthority = {
      async acquire(threadId, runId) {
        return { threadId, runId, holderId: "holder-1" };
      },
      async renew() {
        throw new Error("lease store unavailable");
      },
      async holder() {
        return null;
      },
      async publish() {},
      async bindTurn() {},
      async setInboxConsumption() {
        return true;
      },
      async read() {
        return { kind: "asleep" };
      },
      async readRunningTurnId() {
        return null;
      },
      async readMany() {
        return new Map();
      },
      async cancel() {
        return false;
      },
      async release() {},
    };
    const heartbeat = createHeartbeatRunAuthority(authority, {
      eventSink,
      leaseTtlMs: 3_000,
    });
    const lease = required(await heartbeat.acquire(THREAD_A, "run-1"));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(eventSink.events.map((event) => event.name)).toEqual(["lease.renew_failed"]);
    expect(eventSink.events[0]?.level).toBe("warn");
    await heartbeat.release(lease);
  });

  it("reports a lost lease once and stops renewing", async () => {
    vi.useFakeTimers();
    const eventSink = createInMemoryEventSink();
    let renewals = 0;
    const authority: RunAuthority = {
      async acquire(threadId, runId) {
        return { threadId, runId, holderId: "holder-1" };
      },
      async renew() {
        renewals += 1;
        return false;
      },
      async holder() {
        return null;
      },
      async publish() {},
      async bindTurn() {},
      async setInboxConsumption() {
        return true;
      },
      async read() {
        return { kind: "asleep" };
      },
      async readRunningTurnId() {
        return null;
      },
      async readMany() {
        return new Map();
      },
      async cancel() {
        return false;
      },
      async release() {},
    };
    const heartbeat = createHeartbeatRunAuthority(authority, {
      eventSink,
      leaseTtlMs: 3_000,
    });
    const lease = required(await heartbeat.acquire(THREAD_A, "run-1"));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(renewals).toBe(1);
    expect(eventSink.events.map((event) => event.name)).toEqual(["lease.lost"]);
    expect(eventSink.events[0]?.level).toBe("warn");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewals).toBe(1);
    expect(eventSink.events.map((event) => event.name)).toEqual(["lease.lost"]);
    await heartbeat.release(lease);
  });

  it("keeps a lease alive across a call longer than its TTL", async () => {
    vi.useFakeTimers();
    const eventSink = createInMemoryEventSink();
    let renewals = 0;
    let expiresAt = 0;
    const authority: RunAuthority = {
      async acquire(threadId, runId) {
        expiresAt = Date.now() + 30_000;
        return { threadId, runId, holderId: "holder-1" };
      },
      async renew() {
        renewals += 1;
        if (Date.now() > expiresAt) return false;
        expiresAt = Date.now() + 30_000;
        return true;
      },
      async holder() {
        return null;
      },
      async publish() {},
      async bindTurn() {},
      async setInboxConsumption() {
        return true;
      },
      async read() {
        return { kind: "asleep" };
      },
      async readRunningTurnId() {
        return null;
      },
      async readMany() {
        return new Map();
      },
      async cancel() {
        return false;
      },
      async release() {},
    };
    const heartbeat = createHeartbeatRunAuthority(authority, {
      eventSink,
      leaseTtlMs: 30_000,
    });
    const lease = required(await heartbeat.acquire(THREAD_A, "run-1"));

    // A model call that streams for 45s (> TTL) while the heartbeat stays live.
    const inFlightCall = (async () => {
      for (let i = 0; i < 45; i++) await new Promise((resolve) => setTimeout(resolve, 1_000));
      return "finished";
    })();

    await vi.advanceTimersByTimeAsync(45_000);

    expect(await inFlightCall).toBe("finished");
    expect(renewals).toBeGreaterThanOrEqual(4);
    expect(Date.now()).toBeLessThan(expiresAt);
    expect(eventSink.events.map((event) => event.name)).not.toContain("lease.lost");
    await heartbeat.release(lease);
  });
});
