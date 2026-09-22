/** Account recents keep a newer local opening ahead of a stale or unchanged server list. */
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
    address: {
      kind: "document",
      scheme: "manuscript",
      path: `/${documentId}.md`,
      workId: null,
      workSlug: null,
    },
  });
}

function row(documentId: string, openedAt: string, name = `${documentId}.md`): ServerRecentRow {
  return {
    documentId,
    name,
    scheme: "manuscript",
    path: `/${documentId}.md`,
    workSlug: null,
    openedAt,
  };
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
    expect(again.forProject("project").map((item) => item.documentId)).toEqual(["chapter"]);
  });

  it("caps the account at 50 and puts the newest open first", () => {
    const recents = store();
    recents.setUser("account");
    for (let index = 0; index < ACCOUNT_RECENTS_CAP + 1; index += 1) {
      open(recents, `doc-${index}`, `2026-09-22T12:00:${String(index).padStart(2, "0")}.000Z`);
    }
    const ids = recents.items.map((item) => item.documentId);
    expect(ids).toHaveLength(ACCOUNT_RECENTS_CAP);
    expect(ids[0]).toBe(`doc-${ACCOUNT_RECENTS_CAP}`);
    expect(ids).not.toContain("doc-0");
    open(recents, "doc-1", "2026-09-22T13:00:00.000Z");
    expect(recents.items[0]?.documentId).toBe("doc-1");
  });

  it("keeps a local opening that a list started before, or has not acknowledged", () => {
    const recents = store();
    recents.setUser("account");
    open(recents, "older", "2026-09-22T11:00:00.000Z");
    const before = recents.revision;
    open(recents, "chapter", "2026-09-22T12:00:00.000Z");

    recents.applyServerList(
      "account",
      "project",
      [row("older", "2026-09-22T11:00:00.000Z")],
      before,
    );
    expect(recents.forProject("project").map((item) => item.documentId)).toEqual([
      "chapter",
      "older",
    ]);

    recents.applyServerList("account", "project", [], recents.revision);
    expect(recents.forProject("project").map((item) => item.documentId)).toEqual([
      "chapter",
      "older",
    ]);
  });

  it("does not restore server rank when the server row did not move", () => {
    const recents = store();
    recents.setUser("account");
    open(recents, "beta", "2026-09-22T12:00:00.000Z");
    recents.noteServerRow("account", "beta");
    open(recents, "chapter", "2026-09-22T12:00:05.000Z");
    const captured = recents.revision;
    recents.noteServerRow("account", "chapter");

    recents.applyServerList(
      "account",
      "project",
      [row("beta", "2026-09-22T12:00:04.000Z"), row("chapter", "2026-09-22T11:00:00.000Z")],
      captured,
    );
    expect(recents.forProject("project").map((item) => item.documentId)).toEqual([
      "chapter",
      "beta",
    ]);
    expect(recents.forProject("project")[0]?.openedAt).toBe("2026-09-22T12:00:05.000Z");
  });

  it("adopts a newer server open and drops a row the server no longer lists", () => {
    const recents = store();
    recents.setUser("account");
    open(recents, "chapter", "2026-09-22T12:00:00.000Z");
    recents.noteServerRow("account", "chapter");
    const captured = recents.revision;

    recents.applyServerList(
      "account",
      "project",
      [row("chapter", "2026-09-22T12:05:00.000Z"), row("other", "2026-09-22T12:04:00.000Z")],
      captured,
    );
    expect(recents.forProject("project").map((item) => [item.documentId, item.openedAt])).toEqual([
      ["chapter", "2026-09-22T12:05:00.000Z"],
      ["other", "2026-09-22T12:04:00.000Z"],
    ]);

    recents.applyServerList(
      "account",
      "project",
      [row("other", "2026-09-22T12:04:00.000Z")],
      recents.revision,
    );
    expect(recents.forProject("project").map((item) => item.documentId)).toEqual(["other"]);
  });

  it("does not let a list that started before deletion resurrect the row", () => {
    const recents = store();
    recents.setUser("account");
    open(recents, "chapter", "2026-09-22T12:00:00.000Z");
    recents.noteServerRow("account", "chapter");
    const beforeDelete = recents.revision;
    recents.applyAvailability("account", {
      removed: [{ documentId: "chapter", projectId: "project" }],
      updates: [],
    });

    recents.applyServerList(
      "account",
      "project",
      [row("chapter", "2026-09-22T12:00:00.000Z")],
      beforeDelete,
    );
    recents.applyServerList(
      "account",
      "project",
      [row("chapter", "2026-09-22T12:00:00.000Z")],
      recents.revision,
    );
    expect(recents.forProject("project")).toEqual([]);
  });

  it("updates a renamed locator without moving rank, and ignores a stale list name", () => {
    const recents = store();
    recents.setUser("account");
    open(recents, "chapter", "2026-09-22T12:00:00.000Z");
    recents.noteServerRow("account", "chapter");
    const beforeRename = recents.revision;
    recents.applyAvailability("account", {
      removed: [],
      updates: [
        {
          documentId: "chapter",
          name: "Renamed.md",
          scheme: "kb",
          path: "/Renamed.md",
          workId: null,
        },
      ],
    });
    const renamed = recents.forProject("project")[0];
    expect(renamed?.openedAt).toBe("2026-09-22T12:00:00.000Z");
    expect(renamed?.name).toBe("Renamed.md");
    expect(renamed?.address).toMatchObject({ scheme: "kb", path: "/Renamed.md" });

    recents.applyServerList(
      "account",
      "project",
      [row("chapter", "2026-09-22T12:00:00.000Z", "chapter.md")],
      beforeRename,
    );
    expect(recents.forProject("project")[0]?.name).toBe("Renamed.md");
  });

  it("refuses a switched account's in-flight list", () => {
    const recents = store();
    recents.setUser("account");
    open(recents, "chapter", "2026-09-22T12:00:00.000Z");
    recents.setUser("other");
    recents.applyServerList("account", "project", [row("leaked", "2026-09-22T13:00:00.000Z")], 0);
    expect(recents.items).toEqual([]);
  });
});
