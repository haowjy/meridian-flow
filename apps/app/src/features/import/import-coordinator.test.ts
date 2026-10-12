import { describe, expect, it } from "vitest";
import { ImportRequestError } from "@/client/api/imports-api";
import type { ImportDestination } from "./destination";
import { fakeImportServer } from "./fake-import-server";
import { ImportCoordinator } from "./import-coordinator";
import { displayOf } from "./import-store";
import type { Selection } from "./selection";

const destination: ImportDestination = {
  scheme: "kb",
  path: "/",
  uri: "kb://",
  name: "Knowledge Base",
  folderId: null,
};

function vault(): Selection {
  const file = (path: string) => ({
    path,
    file: new File([`# ${path}`], path.split("/").at(-1) ?? path),
  });
  return {
    leftOut: [],
    roots: [
      {
        rootId: 0,
        kind: "folder",
        name: "vault",
        files: [file("Ch 1.md"), file("Ch 2.md"), file("Lore/Sects.md")],
        folders: ["Empty"],
        unreadable: [],
      },
    ],
  };
}

async function settled(coordinator: ImportCoordinator, importId: string) {
  const store = coordinator.store(importId);
  for (let tick = 0; tick < 200; tick += 1) {
    const phase = store.getSnapshot().local?.phase.kind;
    if (phase === "idle" || phase === "not-started" || phase === "stop-failed") return store;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("import never settled");
}

describe("ImportCoordinator.start", () => {
  it("answers at once with the rows drawn, then plans and uploads in the background", async () => {
    const server = fakeImportServer();
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(vault(), destination);

    const first = coordinator.store(importId).getSnapshot();
    expect(server.calls.plan).toBe(0);
    expect(first.local?.rows.map((row) => [row.kind, row.parentPath, row.name])).toEqual(
      expect.arrayContaining([
        ["dir", "/", "vault"],
        ["dir", "/vault", "Empty"],
        ["dir", "/vault", "Lore"],
        ["file", "/vault", "Ch 1"],
        ["file", "/vault/Lore", "Sects"],
      ]),
    );
    expect(displayOf(first)).toBe("preparing");

    const store = await settled(coordinator, importId);
    expect(server.calls.plan).toBe(1);
    expect(server.calls.send.flat().sort()).toEqual([0, 1, 2]);
    expect(store.getSnapshot().report?.summary.state).toBe("finished");
    expect(displayOf(store.getSnapshot())).toBe("finished");
  });

  it("fails one file alone, shows needs-attention, and Retry lands it", async () => {
    const server = fakeImportServer({ failSend: (entryId) => entryId === 1 });
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(vault(), destination);
    const store = await settled(coordinator, importId);

    const state = store.getSnapshot();
    expect([...(state.local?.failures.keys() ?? [])]).toEqual([1]);
    expect(state.report?.entries.get(0)?.state).toBe("landed");
    expect(state.report?.entries.get(2)?.state).toBe("landed");
    expect(displayOf(state)).toBe("needs-attention");

    server.setFailSend(() => false);
    coordinator.retry(importId, [1]);
    expect(displayOf(store.getSnapshot())).toBe("importing");
    await settled(coordinator, importId);
    expect(store.getSnapshot().report?.entries.get(1)?.state).toBe("landed");
    expect(store.getSnapshot().local?.failures.size).toBe(0);
  });

  it("shows didn't-start when the plan is refused, and tries again with the same id", async () => {
    const server = fakeImportServer();
    let refuse = true;
    const plan = server.api.plan;
    server.api.plan = async (...args) => {
      if (refuse) throw new ImportRequestError(413, "too_many_files", { limit: 10000 }, "refused");
      return plan(...args);
    };
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(vault(), destination);
    const store = await settled(coordinator, importId);
    expect(displayOf(store.getSnapshot())).toBe("didnt-start");

    refuse = false;
    coordinator.tryAgain(importId);
    await settled(coordinator, importId);
    expect(displayOf(store.getSnapshot())).toBe("finished");
  });
});

describe("ImportCoordinator.stop", () => {
  it("ends locally when nothing was sent", async () => {
    const server = fakeImportServer();
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(vault(), destination);
    expect(await coordinator.stop(importId)).toBe("nothing-sent");
    expect(server.calls.finish).toBe(0);
    expect(coordinator.store(importId).getSnapshot().local?.rows).toEqual([]);
  });

  it("finishes with what landed and says Couldn't stop when the finish fails", async () => {
    const server = fakeImportServer({ failSend: (entryId) => entryId === 1 });
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(vault(), destination);
    const store = await settled(coordinator, importId);
    const finish = server.api.finish;
    server.api.finish = async () => {
      throw new ImportRequestError(0, null, undefined, "offline");
    };
    expect(await coordinator.stop(importId)).toBe("failed");
    expect(displayOf(store.getSnapshot())).toBe("couldnt-stop");
    server.api.finish = finish;
    expect(await coordinator.stop(importId)).toBe("stopped");
    expect(displayOf(store.getSnapshot())).toBe("finished");
    expect(store.getSnapshot().report?.summary.counts.notImported).toBe(1);
  });
});
