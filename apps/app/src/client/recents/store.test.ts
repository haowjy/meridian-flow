/** A list may add a newer opening. It cannot delete, overwrite a locator, or undo a removal. */
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_RECENTS_CAP,
  ACCOUNT_RECENTS_STORAGE_KEY,
  DeviceAccountRecentsStore,
  type RecentsStorage,
  type ServerRecentRow,
} from "./store";

function memory(): RecentsStorage & { raw(): string | null } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    raw: () => values.get(ACCOUNT_RECENTS_STORAGE_KEY) ?? null,
  };
}

function store() {
  return new DeviceAccountRecentsStore(memory());
}

function open(
  recents: DeviceAccountRecentsStore,
  documentId: string,
  openedAt: string,
  projectId = "project",
) {
  return recents.touch("account", {
    documentId,
    projectId,
    name: `${documentId}.md`,
    openedAt,
    address: { kind: "document", scheme: "manuscript", path: `/${documentId}.md` },
  });
}

function row(documentId: string, openedAt: string, name = `${documentId}.md`): ServerRecentRow {
  return {
    documentId,
    name,
    scheme: "manuscript",
    path: `/${documentId}.md`,
    openedAt,
  };
}

function ids(recents: DeviceAccountRecentsStore) {
  return recents.forProject("project").map((item) => item.documentId);
}

describe("account recents", () => {
  it("discards another account wholesale and reloads the matching record", () => {
    const storage = memory();
    const first = new DeviceAccountRecentsStore(storage);
    first.setUser("account");
    open(first, "chapter", "2026-09-22T12:00:00.000Z");

    const other = new DeviceAccountRecentsStore(storage);
    other.setUser("other");
    expect(other.forProject("project")).toEqual([]);
    expect(storage.raw()).toBeNull();

    const restored = new DeviceAccountRecentsStore(storage);
    restored.setUser("account");
    expect(restored.forProject("project")).toEqual([]);
    open(restored, "chapter", "2026-09-22T12:00:00.000Z");
    const again = new DeviceAccountRecentsStore(storage);
    again.setUser("account");
    expect(ids(again)).toEqual(["chapter"]);
  });

  it("keeps a local opening an omitting or older list does not contain", () => {
    const recents = store();
    recents.setUser("account");
    open(recents, "chapter", "2026-09-22T12:00:00.000Z");
    open(recents, "older", "2026-09-22T11:00:00.000Z");

    recents.applyServerList("account", "project", [], recents.epoch);
    recents.applyServerList(
      "account",
      "project",
      [row("older", "2026-09-22T10:00:00.000Z", "stale.md")],
      recents.epoch,
    );
    expect(ids(recents)).toEqual(["chapter", "older"]);
    expect(recents.forProject("project")[1]).toMatchObject({
      name: "older.md",
      openedAt: "2026-09-22T11:00:00.000Z",
      address: { path: "/older.md" },
    });
  });

  it("adopts a newer server open and adds an unknown row without demoting a local one", () => {
    const recents = store();
    recents.setUser("account");
    open(recents, "chapter", "2026-09-22T12:00:00.000Z");

    recents.applyServerList(
      "account",
      "project",
      [row("chapter", "2026-09-22T12:05:00.000Z"), row("other", "2026-09-22T12:04:00.000Z")],
      recents.epoch,
    );
    expect(recents.forProject("project").map((item) => [item.documentId, item.openedAt])).toEqual([
      ["chapter", "2026-09-22T12:05:00.000Z"],
      ["other", "2026-09-22T12:04:00.000Z"],
    ]);
    expect(recents.forProject("project")[0]?.name).toBe("chapter.md");
  });

  it("does not let an omitting list clear a removal or a later list resurrect it", () => {
    const recents = store();
    recents.setUser("account");
    open(recents, "chapter", "2026-09-22T12:00:00.000Z");
    recents.applyAvailability("account", {
      removed: [{ documentId: "chapter", projectId: "project" }],
      updates: [],
    });

    recents.applyServerList("account", "project", [], recents.epoch);
    recents.applyServerList(
      "account",
      "project",
      [row("chapter", "2026-09-22T12:00:00.000Z")],
      recents.epoch,
    );
    expect(ids(recents)).toEqual([]);

    open(recents, "chapter", "2026-09-22T13:00:00.000Z");
    recents.applyServerList(
      "account",
      "project",
      [row("chapter", "2026-09-22T12:00:00.000Z")],
      recents.epoch,
    );
    expect(ids(recents)).toEqual(["chapter"]);
  });

  it("does not let foreign removals evict a recent removal in a mixed availability batch", () => {
    const recents = store();
    recents.setUser("account");
    open(recents, "chapter", "2026-09-22T12:00:00.000Z");
    open(recents, "live", "2026-09-22T12:01:00.000Z");
    recents.applyAvailability("account", {
      removed: [{ documentId: "chapter", projectId: "project" }],
      updates: [],
    });
    recents.applyAvailability("account", {
      removed: Array.from({ length: ACCOUNT_RECENTS_CAP }, (_, index) => ({
        documentId: `foreign-${index}`,
        projectId: "project",
      })),
      updates: [{ documentId: "live", name: "Renamed.md", scheme: "kb", path: "/Renamed.md" }],
    });
    recents.applyServerList(
      "account",
      "project",
      [row("chapter", "2026-09-22T13:00:00.000Z")],
      recents.epoch,
    );
    expect(ids(recents)).toEqual(["live"]);
    expect(recents.items[0]?.name).toBe("Renamed.md");
  });

  it("updates identity from availability and an open tab, including a local draft rename", () => {
    const recents = store();
    recents.setUser("account");
    open(recents, "chapter", "2026-09-22T12:00:00.000Z");
    recents.touch("account", {
      documentId: "draft",
      projectId: "project",
      name: "Untitled",
      openedAt: "2026-09-22T12:01:00.000Z",
      address: { kind: "local", resourceHandle: "resource" },
    });
    recents.applyAvailability("account", {
      removed: [],
      updates: [{ documentId: "chapter", name: "Renamed.md", scheme: "kb", path: "/Renamed.md" }],
    });
    recents.patchFromTabs("account", "project", [
      {
        documentId: "draft",
        name: "Chapter one",
        address: { kind: "local", resourceHandle: "resource" },
      },
    ]);

    const filed = recents.forProject("project").find((item) => item.documentId === "chapter");
    const draft = recents.forProject("project").find((item) => item.documentId === "draft");
    expect(filed).toMatchObject({
      name: "Renamed.md",
      openedAt: "2026-09-22T12:00:00.000Z",
      address: { scheme: "kb", path: "/Renamed.md" },
    });
    expect(draft).toMatchObject({
      name: "Chapter one",
      openedAt: "2026-09-22T12:01:00.000Z",
      address: { kind: "local", resourceHandle: "resource" },
    });
    recents.applyServerList(
      "account",
      "project",
      [row("chapter", "2026-09-22T12:00:00.000Z", "chapter.md")],
      recents.epoch,
    );
    expect(recents.forProject("project").find((item) => item.documentId === "chapter")?.name).toBe(
      "Renamed.md",
    );
  });

  it("ignores a list captured before the account was bound again", () => {
    const recents = store();
    recents.setUser("account");
    const staleEpoch = recents.epoch;
    open(recents, "chapter", "2026-09-22T12:00:00.000Z");
    recents.setUser("other");
    recents.setUser("account");

    expect(
      recents.applyServerList(
        "account",
        "project",
        [row("frozen", "2026-09-22T12:00:00.000Z")],
        staleEpoch,
      ),
    ).toBe(false);
    expect(recents.items).toEqual([]);

    recents.applyServerList(
      "account",
      "project",
      [row("fresh", "2026-09-22T12:00:00.000Z")],
      recents.epoch,
    );
    expect(ids(recents)).toEqual(["fresh"]);
  });

  it("refuses a switched account's in-flight list", () => {
    const recents = store();
    recents.setUser("account");
    open(recents, "chapter", "2026-09-22T12:00:00.000Z");
    const epoch = recents.epoch;
    recents.setUser("other");
    recents.applyServerList(
      "account",
      "project",
      [row("leaked", "2026-09-22T13:00:00.000Z")],
      epoch,
    );
    expect(recents.items).toEqual([]);
  });
});
