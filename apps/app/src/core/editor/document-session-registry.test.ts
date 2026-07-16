/** Regression coverage for replacing pre-materialization authorization failures. */

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
});
