import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { navigateToPassage } from "./passage-navigation";

function openedBinding({
  status = "synced",
  sync = async () => undefined,
}: {
  status?: "synced" | "syncing";
  sync?: () => Promise<void>;
} = {}) {
  const doc = new Y.Doc({ gc: false });
  const release = vi.fn();
  const bind = vi.fn(async () => ({
    projectId: "project-1",
    documentId: "document-1",
    generation: "3",
    session: {
      document: doc,
      waitForCurrentSync: sync,
      getSnapshot: () => ({ status }),
    } as never,
    release,
  }));
  return {
    bind,
    release,
    openDocument: async () => ({
      kind: "opened" as const,
      document: {} as never,
      admission: {
        projectId: "project-1",
        documentId: "document-1",
        generation: "3",
        bind,
      },
    }),
  };
}

describe("passage navigation", () => {
  it.each([
    "landed",
    "stale",
  ] as const)("returns %s from the exact bound session", async (outcome) => {
    const binding = openedBinding();
    const showPassage = vi.fn(() => ({ outcome }));
    await expect(
      navigateToPassage({
        documentId: "document-1",
        anchor: { blockHash: "missing", term: "Elara" },
        openDocument: binding.openDocument,
        showPassage,
      }),
    ).resolves.toEqual({ kind: outcome });
    expect(binding.bind).toHaveBeenCalledOnce();
    expect(binding.release).toHaveBeenCalledOnce();
  });

  it("awaits current sync and releases once when unavailable", async () => {
    const sync = vi.fn(async () => undefined);
    const binding = openedBinding({ status: "syncing", sync });
    await expect(
      navigateToPassage({
        documentId: "document-1",
        anchor: { blockHash: "missing", term: "Elara" },
        openDocument: binding.openDocument,
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(sync).toHaveBeenCalledOnce();
    expect(binding.release).toHaveBeenCalledOnce();
  });

  it("cancels a late sync and releases the old exact binding once", async () => {
    const controller = new AbortController();
    const binding = openedBinding({ sync: () => new Promise<void>(() => undefined) });
    const navigating = navigateToPassage({
      documentId: "document-1",
      anchor: { blockHash: "missing", term: "Elara" },
      openDocument: binding.openDocument,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(binding.bind).toHaveBeenCalledOnce());
    controller.abort();
    await expect(navigating).resolves.toEqual({ kind: "unavailable" });
    expect(binding.release).toHaveBeenCalledOnce();
  });
});
