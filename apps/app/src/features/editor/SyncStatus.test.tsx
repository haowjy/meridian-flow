/**
 * SyncStatus contract: the pill renders exactly one label. An outage (offline,
 * or a detached session whose adoption stalled) keeps saying "Saved locally
 * (offline)" until the server has acknowledged every local change, swaps to the
 * confirmation in place, and then hides. "Closed" and "Access lost" always win.
 * Healthy use, including a cold load's brief detached phase, shows nothing.
 */
import { act, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DocumentSession,
  type DocumentSessionConnectionState,
  type DocumentSessionSnapshot,
  type DocumentSessionStatus,
  type DocumentSessionTransportProvider,
} from "@/core/editor/document-session";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { SyncStatus } from "./SyncStatus";

function fakeSession(initial: Partial<DocumentSessionSnapshot> = {}) {
  let snapshot: DocumentSessionSnapshot = {
    documentId: "doc-1",
    roomKey: "doc-1",
    room: { kind: "live", documentId: "doc-1" },
    status: "synced",
    serverHasLocalChanges: false,
    adoptionStalled: false,
    connectionState: null,
    access: null,
    localPersistenceSynced: true,
    schemaFence: null,
    schemaRepairs: [],
    ...initial,
  };
  const listeners = new Set<(next: DocumentSessionSnapshot) => void>();
  const session = {
    getSnapshot: () => snapshot,
    subscribe(listener: (next: DocumentSessionSnapshot) => void) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
  } as unknown as DocumentSession;
  return {
    session,
    set(status: DocumentSessionStatus, serverHasLocalChanges = false) {
      snapshot = { ...snapshot, status, serverHasLocalChanges };
      act(() => {
        for (const listener of listeners) listener(snapshot);
      });
    },
  };
}

/** Controllable transport for a real DocumentSession: connect, finish the handshake, acknowledge. */
function controllableTransport() {
  let onStatus: (state: DocumentSessionConnectionState) => void = () => {};
  let onAcknowledged: (acknowledged: boolean) => void = () => {};
  const provider: DocumentSessionTransportProvider = {
    synced: true,
    whenSynced: Promise.resolve(),
    subscribeStatus(listener) {
      onStatus = listener;
      listener({ kind: "connecting", attempt: 1 });
      return () => {};
    },
    subscribeServerAcknowledgement(listener) {
      onAcknowledged = listener;
      listener(false);
      return () => {};
    },
    destroy() {},
  };
  return {
    factory: () => provider,
    connect: () => onStatus({ kind: "connected" }),
    acknowledge: () => onAcknowledged(true),
  };
}

const pill = () => document.querySelector('[role="status"]');
const OFFLINE = "Saved locally (offline)";
const CONFIRMED = "Back online (all changes saved)";

describe("SyncStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing on a first load, even once the server has everything", async () => {
    const fake = fakeSession({ status: "syncing" });
    await withReactRoot(<SyncStatus session={fake.session} />, () => {
      expect(pill()).toBeNull();
      fake.set("synced", false);
      expect(pill()).toBeNull();
      fake.set("synced", true);
      expect(pill()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(pill()).toBeNull();
    });
  });

  it("holds the offline label through reconnect, swaps in place to the confirmation, then hides", async () => {
    const fake = fakeSession({ status: "synced", serverHasLocalChanges: true });
    await withReactRoot(<SyncStatus session={fake.session} />, () => {
      fake.set("offline");
      const offlinePill = pill();
      expect(offlinePill?.textContent).toContain(OFFLINE);

      // Reconnect handshake in flight, then connected but not yet acknowledged.
      fake.set("syncing");
      expect(pill()).toBe(offlinePill);
      expect(pill()?.textContent).toContain(OFFLINE);
      fake.set("synced", false);
      expect(pill()).toBe(offlinePill);
      expect(pill()?.textContent).toContain(OFFLINE);

      // Same element, new text: the pill is never absent between the labels.
      fake.set("synced", true);
      expect(pill()).toBe(offlinePill);
      expect(pill()?.textContent).toContain(CONFIRMED);

      act(() => {
        vi.advanceTimersByTime(2_900);
      });
      expect(pill()?.textContent).toContain(CONFIRMED);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(pill()).toBeNull();
    });
  });

  it("goes straight back to the offline label if the connection drops during the confirmation", async () => {
    const fake = fakeSession();
    await withReactRoot(<SyncStatus session={fake.session} />, () => {
      fake.set("offline");
      fake.set("synced", true);
      expect(pill()?.textContent).toContain(CONFIRMED);

      fake.set("offline");
      expect(pill()?.textContent).toContain(OFFLINE);

      // The stale confirmation timer must not hide the new outage.
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(pill()?.textContent).toContain(OFFLINE);
    });
  });

  it("ends the confirmation at once on a fresh edit, without an offline label or a flicker", async () => {
    const fake = fakeSession();
    await withReactRoot(<SyncStatus session={fake.session} />, () => {
      fake.set("offline");
      fake.set("synced", true);
      expect(pill()?.textContent).toContain(CONFIRMED);

      // The writer types: the server no longer has everything.
      fake.set("synced", false);
      expect(pill()).toBeNull();

      // Its acknowledgement does not bring the confirmation back.
      fake.set("synced", true);
      expect(pill()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(pill()).toBeNull();
    });
  });

  it("does not carry outage state or the confirmation timer into a replacement session", async () => {
    const confirmed = fakeSession();
    const healthy = fakeSession({ status: "synced", serverHasLocalChanges: false });
    const pending = fakeSession({ status: "offline" });

    // Every committed frame is recorded, so a one-frame leak is visible.
    const committed: Array<string | null | undefined> = [];
    let swap: (session: DocumentSession) => void = () => {};
    const Host = () => {
      const [session, setSession] = useState(confirmed.session);
      swap = (next) => act(() => setSession(next));
      useLayoutEffect(() => {
        committed.push(pill()?.textContent);
      });
      return <SyncStatus session={session} />;
    };

    await withReactRoot(<Host />, () => {
      confirmed.set("offline");
      confirmed.set("synced", true);
      expect(pill()?.textContent).toContain(CONFIRMED);

      // Confirmed session A -> never-offline session B: B shows nothing.
      committed.length = 0;
      swap(healthy.session);
      expect(committed.length).toBeGreaterThan(0);
      expect(committed.some((text) => text?.includes(CONFIRMED))).toBe(false);
      expect(pill()).toBeNull();
      // B's first acknowledgement is not an outage recovery.
      healthy.set("synced", true);
      expect(pill()).toBeNull();

      // Awaiting session A -> healthy session B: B does not inherit the offline label.
      swap(pending.session);
      expect(pill()?.textContent).toContain(OFFLINE);
      committed.length = 0;
      swap(healthy.session);
      expect(committed.length).toBeGreaterThan(0);
      expect(committed.some((text) => text?.includes(OFFLINE))).toBe(false);
      healthy.set("synced", true);
      expect(pill()).toBeNull();
    });
  });

  it("shows only 'Closed' for a session destroyed after an adoption failure", async () => {
    const session = new DocumentSession({
      roomKey: "doc-sync-status",
      persistence: { kind: "none" },
    });
    session.reportAdoptionStalled(true);

    await withReactRoot(<SyncStatus session={session} />, async () => {
      expect(document.body.textContent).toBe(OFFLINE);
      await act(async () => {
        await session.destroy();
      });
      expect(document.body.textContent).toBe("Closed");
    });
  });

  it("treats a stalled adoption as an outage: offline label until the server has everything, one confirmation, then hides", async () => {
    const session = new DocumentSession({
      roomKey: "doc-stalled-recovery",
      persistence: { kind: "none" },
    });
    const transport = controllableTransport();

    await withReactRoot(<SyncStatus session={session} />, async () => {
      // A healthy cold load is detached for a while: no label, and no timer turns it into one.
      expect(pill()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(pill()).toBeNull();

      act(() => session.reportAdoptionStalled(true));
      const stalledPill = pill();
      expect(stalledPill?.textContent).toContain(OFFLINE);

      // Transport attaches and finishes its handshake, but nothing is acknowledged yet.
      await act(async () => {
        session.attachTransport(transport.factory);
        transport.connect();
        await session.whenSynced();
      });
      expect(session.getSnapshot()).toMatchObject({
        status: "synced",
        adoptionStalled: false,
        serverHasLocalChanges: false,
      });
      expect(pill()).toBe(stalledPill);
      expect(pill()?.textContent).toContain(OFFLINE);

      act(() => transport.acknowledge());
      expect(pill()).toBe(stalledPill);
      expect(pill()?.textContent).toContain(CONFIRMED);
      act(() => {
        vi.advanceTimersByTime(3_100);
      });
      expect(pill()).toBeNull();

      // The confirmation is a one-off: nothing brings it back.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(pill()).toBeNull();
    });
  });

  it("shows the offline label on the first render for a session already stalled when the pill mounts", async () => {
    const session = new DocumentSession({
      roomKey: "doc-stalled-mounted",
      persistence: { kind: "none" },
    });
    session.reportAdoptionStalled(true);

    const committed: Array<string | null | undefined> = [];
    const Probe = () => {
      useLayoutEffect(() => {
        committed.push(pill()?.textContent);
      });
      return <SyncStatus session={session} />;
    };

    await withReactRoot(<Probe />, () => {
      expect(committed[0]).toContain(OFFLINE);
    });
  });
});
