/**
 * SyncStatus contract: after an outage the pill keeps saying "Saved locally
 * (offline)" until the server has acknowledged every local change, swaps to
 * the confirmation in place, and then hides. Healthy use shows nothing.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DocumentSession,
  DocumentSessionSnapshot,
  DocumentSessionStatus,
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
    connectionState: null,
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

  it("keeps the confirmation through a fresh edit while the connection stays healthy", async () => {
    const fake = fakeSession();
    await withReactRoot(<SyncStatus session={fake.session} />, () => {
      fake.set("offline");
      fake.set("synced", true);
      fake.set("synced", false);
      expect(pill()?.textContent).toContain(CONFIRMED);
    });
  });
});
