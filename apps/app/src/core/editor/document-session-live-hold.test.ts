/**
 * Guards the no-lost-edit rule: a released live session with unacknowledged edits stays open
 * until the server has them, and only the exits below end the wait.
 */
import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import type { CrossContextLockManager } from "../cross-context-locks";
import type {
  DocumentSessionAccess,
  DocumentSessionConnectionState,
  DocumentSessionTransportProvider,
} from "./document-session";
import { createDocumentSessionCrossContextCoordination } from "./document-session-cross-context-coordination";
import { DocumentSessionRegistry } from "./document-session-registry-implementation";

const GRACE_MS = 10;

const locks: CrossContextLockManager = { request: async (_n, _o, callback) => callback({}) };

function scriptedTransport() {
  let outbox: Uint8Array | null = new Uint8Array([1]);
  let state: DocumentSessionConnectionState = { kind: "connected" };
  const statusListeners = new Set<(s: DocumentSessionConnectionState) => void>();
  const accessListeners = new Set<(a: DocumentSessionAccess) => void>();
  const ackListeners = new Set<(acknowledged: boolean) => void>();
  const script = {
    destroyed: false,
    acknowledge() {
      outbox = null;
      for (const listener of ackListeners) listener(true);
    },
    setState(next: DocumentSessionConnectionState) {
      state = next;
      for (const listener of statusListeners) listener(next);
    },
    setAccess(access: DocumentSessionAccess) {
      for (const listener of accessListeners) listener(access);
    },
  };
  const provider: DocumentSessionTransportProvider = {
    unacknowledgedUpdates: () => outbox,
    synced: true,
    whenSynced: Promise.resolve(),
    subscribeStatus(listener) {
      statusListeners.add(listener);
      listener(state);
      return () => statusListeners.delete(listener);
    },
    subscribeAccess(listener) {
      accessListeners.add(listener);
      return () => accessListeners.delete(listener);
    },
    subscribeServerAcknowledgement(listener) {
      ackListeners.add(listener);
      return () => ackListeners.delete(listener);
    },
    destroy() {
      script.destroyed = true;
    },
  };
  return { script, provider };
}

async function releasedSessionWithUnsentEdits(accountId: string) {
  const { script, provider } = scriptedTransport();
  const registry = new DocumentSessionRegistry(
    (id, local) =>
      createDocumentSessionCrossContextCoordination({
        accountId: id,
        local,
        locks,
        secureContext: true,
        createWakeChannel: null,
        reconcileIntervalMs: 60_000,
      }),
    GRACE_MS,
    accountId,
    () => provider,
  );
  registry.connectLocalResources({
    terminal: { continueTerminal: async () => "completed" },
    lineageHandleFor: async () => "catalog:document-1",
    beginClose: () => undefined,
    finishClose: async () => undefined,
  });
  const lease = await registry.admit("project-1", "document-1", "1");
  registry.retain("host", [lease]);
  await vi.waitFor(() => expect(registry.get(lease).getSnapshot().status).toBe("synced"));
  registry.release("host");
  await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 5));
  return { registry, script };
}

it("holds a released live session with unsent edits until acknowledged, a dead room, read access or account close", async () => {
  const exits: Record<
    string,
    (r: Awaited<ReturnType<typeof releasedSessionWithUnsentEdits>>) => unknown
  > = {
    acknowledgement: ({ script }) => script.acknowledge(),
    "terminal room": ({ script }) =>
      script.setState({ kind: "terminal", reason: "gone", code: 1000 }),
    "read-only access": ({ script }) => script.setAccess("read"),
    "account close": ({ registry }) => registry.closeAccountRuntime(),
  };
  let n = 0;
  for (const [name, exit] of Object.entries(exits)) {
    const held = await releasedSessionWithUnsentEdits(`live-hold-${name}-${++n}`);
    try {
      expect(held.script.destroyed, `${name}: held`).toBe(false);
      await exit(held);
      await vi.waitFor(() => expect(held.script.destroyed, `${name}: retired`).toBe(true));
    } finally {
      await held.registry.closeAccountRuntime();
    }
  }
});

const MINUTE = 60_000;

// The cap counts connected time only. Fake timers start after the real grace has passed; the
// connection is dropped first so the real cap timer is cleared and the fake one arms on reconnect.
async function withFakeClock(
  held: Awaited<ReturnType<typeof releasedSessionWithUnsentEdits>>,
  run: () => Promise<void>,
) {
  held.script.setState({ kind: "reconnecting", attempt: 1, nextRetryAt: 0 });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await run();
  } finally {
    vi.useRealTimers();
    await held.registry.closeAccountRuntime();
  }
}

it("offline time never runs the cap down: it restarts on every drop and delivers on reconnect", async () => {
  const held = await releasedSessionWithUnsentEdits("live-hold-offline");
  await withFakeClock(held, async () => {
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(held.script.destroyed, "offline past the cap").toBe(false);
    held.script.setState({ kind: "connected" });
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    held.script.setState({ kind: "reconnecting", attempt: 1, nextRetryAt: 0 });
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    held.script.setState({ kind: "connected" });
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(held.script.destroyed, "restarted after a drop").toBe(false);
    held.script.acknowledge();
    await vi.waitFor(() => expect(held.script.destroyed, "delivered").toBe(true));
  });
});

it("retires a session that stays connected for the limit without an acknowledgement", async () => {
  const held = await releasedSessionWithUnsentEdits("live-hold-connected");
  await withFakeClock(held, async () => {
    held.script.setState({ kind: "connected" });
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(held.script.destroyed, "just under the limit").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(held.script.destroyed, "at the limit").toBe(true));
  });
});
