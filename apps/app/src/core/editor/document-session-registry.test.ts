/** Regression coverage for replacing pre-materialization authorization failures. */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "@/core/transport/ThreadTransport";

const providers: Array<{
  emit: (state: ConnectionState) => void;
  destroy: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@/core/transport/hocuspocus-document-transport", () => ({
  createHocuspocusDocumentTransport: () => {
    const listeners = new Set<(state: ConnectionState) => void>();
    const provider = {
      emit: (state: ConnectionState) => {
        for (const listener of listeners) listener(state);
      },
      destroy: vi.fn(),
    };
    providers.push(provider);
    return {
      synced: false,
      subscribeStatus: (listener: (state: ConnectionState) => void) => {
        listeners.add(listener);
        listener({ kind: "connecting", attempt: 1 });
        return () => listeners.delete(listener);
      },
      destroy: provider.destroy,
    };
  },
}));

const { DocumentSessionRegistry } = await import("./document-session-registry");

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocumentSessionRegistry.restartUnavailableRoom", () => {
  it("keeps a detached room and its Y.Doc intact until explicit attachment", async () => {
    providers.length = 0;
    const registry = new DocumentSessionRegistry();
    const detached = registry.getDetached("document-detached");
    const document = detached.document;

    expect(detached.getSnapshot().status).toBe("detached");
    expect(providers).toHaveLength(0);
    registry.retain("untitled-tab", ["document-detached"]);
    expect(detached.getSnapshot().status).toBe("detached");
    expect(providers).toHaveLength(0);
    await expect(registry.restartUnavailableRoom("document-detached")).resolves.toBe(false);
    expect(registry.getDetached("document-detached")).toBe(detached);

    expect(registry.get("document-detached")).toBe(detached);
    expect(providers).toHaveLength(0);
    expect(detached.getSnapshot().status).toBe("detached");

    expect(registry.attachDetached("document-detached")).toBe(detached);
    expect(detached.document).toBe(document);
    expect(providers).toHaveLength(1);
    expect(detached.getSnapshot().status).toBe("syncing");
    registry.destroyAll();
  });

  it("starts a fresh teardown grace window after a room is retained again", () => {
    vi.useFakeTimers();
    const registry = new DocumentSessionRegistry();
    registry.retain("owner", ["document-grace"]);
    const session = registry.get("document-grace");

    registry.release("owner");
    vi.advanceTimersByTime(2_800);
    registry.retain("owner", ["document-grace"]);
    registry.release("owner");
    vi.advanceTimersByTime(200);

    expect(registry.has("document-grace")).toBe(true);
    expect(session.getSnapshot().status).not.toBe("destroyed");

    vi.advanceTimersByTime(2_800);
    expect(registry.has("document-grace")).toBe(false);
    expect(session.getSnapshot().status).toBe("destroyed");
    registry.destroyAll();
    vi.useRealTimers();
  });

  it("keeps one session per room while branch rooms remain separate and attached", () => {
    providers.length = 0;
    const registry = new DocumentSessionRegistry();

    const live = registry.get("document-shared");
    expect(registry.get("document-shared")).toBe(live);
    const branch = registry.getRoom("branch:branch-1:gen:1");
    expect(registry.getRoom("branch:branch-1:gen:1")).toBe(branch);
    expect(branch).not.toBe(live);
    expect(branch.document).not.toBe(live.document);
    expect(providers).toHaveLength(2);
    registry.destroyAll();
  });

  it("notifies an observer when a session created after detail load loses access", async () => {
    providers.length = 0;
    const registry = new DocumentSessionRegistry();
    const statuses: string[] = [];
    const unobserve = registry.observe("document-later", (snapshot) =>
      statuses.push(snapshot.status),
    );

    const session = registry.get("document-later");
    await session.waitForCurrentSync(100);
    providers.at(-1)?.emit({ kind: "unauthorized", reason: "revoked", code: 4403 });

    expect(statuses).toContain("access-lost");
    unobserve();
    registry.destroyAll();
  });

  it("replaces a retained live session denied before draft materialization", async () => {
    const registry = new DocumentSessionRegistry();
    registry.retain("test-owner", ["document-1"]);
    const deniedSession = registry.get("document-1");
    await deniedSession.waitForCurrentSync(100);
    const providerCount = providers.length;
    providers.at(-1)?.emit({ kind: "unauthorized", reason: "document access denied", code: 4403 });

    await expect(registry.restartUnavailableRoom("document-1")).resolves.toBe(true);

    expect(providers).toHaveLength(providerCount + 1);
    expect(providers[providerCount - 1]?.destroy).toHaveBeenCalledOnce();
    expect(registry.get("document-1")).not.toBe(deniedSession);
    registry.destroyAll();
  });

  it("does not disrupt a healthy room", async () => {
    providers.length = 0;
    const registry = new DocumentSessionRegistry();
    registry.retain("test-owner", ["document-2"]);
    const session = registry.get("document-2");

    await expect(registry.restartUnavailableRoom("document-2")).resolves.toBe(false);

    expect(providers).toHaveLength(1);
    expect(registry.get("document-2")).toBe(session);
    registry.destroyAll();
  });

  it("keeps quarantined rooms detached and starts them fenced", async () => {
    providers.length = 0;
    vi.stubGlobal("localStorage", memoryStorage());
    const registry = new DocumentSessionRegistry();
    const fence = { reason: "repair-detected", detail: "delete-only repair" } as const;

    registry.quarantineRoom("document-quarantined", fence);
    const quarantined = registry.get("document-quarantined");

    expect(registry.readRoomQuarantine("document-quarantined")).toEqual(fence);
    expect(quarantined.getSnapshot()).toMatchObject({
      status: "detached",
      schemaFence: fence,
    });
    expect(providers).toHaveLength(0);

    registry.clearRoomQuarantine("document-quarantined");
    await registry.destroyRoom("document-quarantined");
    expect(registry.get("document-quarantined").getSnapshot().schemaFence).toBeNull();
    expect(providers).toHaveLength(1);
    registry.destroyAll();
  });

  it("applies persisted quarantine before detached-first acquisition", () => {
    providers.length = 0;
    vi.stubGlobal("localStorage", memoryStorage());
    const registry = new DocumentSessionRegistry();
    const fence = { reason: "repair-detected", detail: "poisoned local replay" } as const;
    expect(registry.quarantineRoom("document-detached-quarantine", fence)).toBe(true);

    const detached = registry.getDetached("document-detached-quarantine");

    expect(detached.getSnapshot()).toMatchObject({ status: "detached", schemaFence: fence });
    expect(registry.get("document-detached-quarantine")).toBe(detached);
    expect(providers).toHaveLength(0);
    registry.destroyAll();
  });

  it("raises the in-memory fence when durable quarantine storage fails", () => {
    providers.length = 0;
    vi.stubGlobal("localStorage", {
      ...memoryStorage(),
      setItem: () => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      },
    });
    const registry = new DocumentSessionRegistry();
    const session = registry.getDetached("document-storage-failure");
    session.awareness.setLocalState({ user: { name: "Writer" } });

    expect(registry.quarantineRoom("document-storage-failure", { reason: "repair-detected" })).toBe(
      false,
    );
    expect(session.getSnapshot().schemaFence).toEqual({ reason: "repair-detected" });
    expect(session.awareness.getLocalState()).toBeNull();
    registry.destroyAll();
  });
});
