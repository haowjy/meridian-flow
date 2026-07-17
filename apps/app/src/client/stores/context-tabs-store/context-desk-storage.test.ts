import { describe, expect, it } from "vitest";
import {
  CONTEXT_DESK_STORAGE_KEY,
  type ContextDeskStorage,
  DeviceContextDeskStore,
} from "./context-desk-storage";
import type { ContextTab } from "./context-tabs-store";

function memoryStorage(initial?: string): ContextDeskStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem() {
      return this.value;
    },
    setItem(_key, value) {
      this.value = value;
    },
    removeItem() {
      this.value = null;
    },
  };
}

const tracked: ContextTab = {
  kind: "tracked",
  documentId: "tracked",
  scheme: "manuscript",
  path: "/chapter.md",
  name: "chapter.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

describe("device context desk persistence", () => {
  it("round-trips the ordered desk and active tab for the same user", () => {
    const storage = memoryStorage();
    const writer = new DeviceContextDeskStore(storage);
    writer.setUser("user-1", () => false);
    writer.replace({ project: { tabs: [tracked], activeTabId: tracked.documentId } }, () => false);

    const reader = new DeviceContextDeskStore(storage);
    expect(reader.setUser("user-1", () => false)).toEqual({
      project: { tabs: [tracked], activeTabId: tracked.documentId },
    });
  });

  it("discards every prior-user desk on a user stamp mismatch", () => {
    const storage = memoryStorage(
      JSON.stringify({
        userId: "user-1",
        projects: { project: { tabs: [tracked], activeTabId: "tracked" } },
      }),
    );
    const store = new DeviceContextDeskStore(storage);

    expect(store.setUser("user-2", () => false)).toEqual({});
    expect(storage.value).toBeNull();
  });

  it("persists pending untitleds but excludes disposable and draft-only tabs", () => {
    const storage = memoryStorage();
    const store = new DeviceContextDeskStore(storage);
    store.setUser("user-1", () => false);
    store.replace(
      {
        project: {
          tabs: [
            tracked,
            { kind: "new", documentId: "empty", name: "Untitled" },
            { kind: "new", documentId: "pending", name: "Untitled" },
            { ...tracked, documentId: "draft", draftOnly: true },
          ],
          activeTabId: "pending",
        },
      },
      (documentId) => documentId === "pending",
    );

    const persisted = JSON.parse(storage.value ?? "null");
    expect(persisted.projects.project).toEqual({
      tabs: [tracked, { kind: "new", documentId: "pending", name: "Untitled" }],
      activeTabId: "pending",
    });
    expect(Object.keys(persisted)).toEqual(["userId", "projects"]);
    expect(CONTEXT_DESK_STORAGE_KEY).toBe("meridian:context-desk");
  });
});
