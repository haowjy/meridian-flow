/** Regression coverage for replacing pre-materialization authorization failures. */

import type { AuthMeResponse, ChangeEventWsMessage } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
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

describe("DocumentSessionRegistry.restartUnavailableRoom", () => {
  it("uses the bootstrap's internal identity for self-suppression, never its external id", () => {
    const authMe = {
      user: {
        userId: "cfeb7b0d-658d-4469-9d69-8aa381d8899f",
        externalId: "user_01workos",
        email: "writer@example.com",
        name: "Writer",
        avatarUrl: null,
      },
    } satisfies AuthMeResponse;
    const registry = new DocumentSessionRegistry();
    const session = registry.getDetached("document-before-auth");
    registry.setOwnUserId(authMe.user.userId);
    session.markerStore.replaceGroup({
      type: "change_event",
      documentId: "document-before-auth",
      threadId: "thread-1",
      trailId: "trail-external",
      projectionRevision: 1,
      author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
      changes: [
        {
          changeId: "change-external",
          admittedByUserId: authMe.user.externalId,
          kind: "delete",
          navigation: {
            kind: "deletion_boundary",
            position: "invalid-but-lazily-decoded",
            affinity: "before_next",
          },
          swept: false,
          excerpt: null,
          pureDeletionOffset: null,
        },
      ],
      truncated: false,
    } satisfies ChangeEventWsMessage);

    expect(session.markerStore.getSnapshot()).toHaveLength(1);

    session.markerStore.replaceGroup({
      type: "change_event",
      documentId: "document-before-auth",
      threadId: "thread-1",
      trailId: "trail-internal",
      projectionRevision: 1,
      author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
      changes: [
        {
          changeId: "change-internal",
          admittedByUserId: authMe.user.userId,
          kind: "delete",
          navigation: {
            kind: "deletion_boundary",
            position: "invalid-but-lazily-decoded",
            affinity: "before_next",
          },
          swept: false,
          excerpt: null,
          pureDeletionOffset: null,
        },
      ],
      truncated: false,
    } satisfies ChangeEventWsMessage);

    expect(session.markerStore.getSnapshot().map((marker) => marker.group.trailId)).toEqual([
      "trail-external",
    ]);
    registry.destroyAll();
  });

  it("keeps a detached room and its Y.Doc intact until explicit attachment", async () => {
    providers.length = 0;
    const registry = new DocumentSessionRegistry();
    registry.retain("untitled-tab", ["document-detached"], {
      detachedRoomKeys: ["document-detached"],
    });
    const detached = registry.getDetached("document-detached");
    const document = detached.document;

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

  it("peeks during the grace window without cancelling teardown", () => {
    vi.useFakeTimers();
    try {
      const registry = new DocumentSessionRegistry();
      registry.retain("owner", ["document-peek"]);
      const session = registry.get("document-peek");
      registry.release("owner");

      expect(registry.peek("document-peek")).toBe(session);
      vi.advanceTimersByTime(3_000);

      expect(registry.has("document-peek")).toBe(false);
      expect(session.getSnapshot().status).toBe("destroyed");
      registry.destroyAll();
    } finally {
      vi.useRealTimers();
    }
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

  it("restarts a denied room's transport without replacing its words or Y.Doc", async () => {
    const registry = new DocumentSessionRegistry();
    registry.retain("test-owner", ["document-1"]);
    const deniedSession = registry.get("document-1");
    deniedSession.document
      .getText("writer-words")
      .insert(0, "words written before materialization");
    const document = deniedSession.document;
    await deniedSession.waitForCurrentSync(100);
    const providerCount = providers.length;
    providers.at(-1)?.emit({ kind: "unauthorized", reason: "document access denied", code: 4403 });

    await expect(registry.restartUnavailableRoom("document-1")).resolves.toBe(true);

    expect(providers).toHaveLength(providerCount + 1);
    expect(providers[providerCount - 1]?.destroy).toHaveBeenCalledOnce();
    expect(registry.get("document-1")).toBe(deniedSession);
    expect(deniedSession.document).toBe(document);
    expect(document.getText("writer-words").toString()).toBe(
      "words written before materialization",
    );
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
});
