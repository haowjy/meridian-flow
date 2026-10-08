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
