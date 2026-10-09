/** App-owned transactions include both new threads and their exact Agent bindings. */
import { describe, expect, it } from "vitest";
import { seedGeneralAgent } from "../domains/packages/index.js";
import { createInMemoryAppServices } from "./compose.js";

describe("in-memory app Agent binding transaction", () => {
  it("rolls back deferred transactions after their originating transaction has finished", async () => {
    const app = createInMemoryAppServices();
    await seedGeneralAgent(app.agentRevisions, "model");
    const general = await app.agentRevisions.readCatalogEntry(null, "general");
    if (!general) throw new Error("Missing General");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deferred: Promise<unknown> = Promise.resolve();
    let id = "";
    await app.repos.transaction(async () => {
      deferred = (async () => {
        await gate;
        return app.repos.transaction(async () => {
          const thread = await app.repos.threads.create({ projectId: "project", userId: "owner" });
          id = thread.id;
          await app.agentRevisions.bindThread(
            id,
            general.selectedRevisionId,
            bindingConfiguration,
            null,
          );
          throw new Error("late rollback");
        });
      })().catch((error) => error.message);
    });
    release();
    expect(await deferred).toBe("late rollback");
    expect(await app.repos.threads.findById(id)).toBeNull();
    expect(await app.agentRevisions.readThreadBinding(id)).toBeUndefined();
  });

  it("hides pending threads without erasing unrelated successful creates on rollback", async () => {
    const app = createInMemoryAppServices();
    let release = () => {};
    let arrived = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let pendingId = "";
    const pending = app.repos
      .transaction(async () => {
        pendingId = (await app.repos.threads.create({ projectId: "project", userId: "owner" })).id;
        arrived();
        await gate;
        throw new Error("rollback");
      })
      .catch((error) => error.message);
    await ready;
    const hidden = await app.repos.threads.findById(pendingId);
    const ordinary = await app.repos.threads.create({ projectId: "project", userId: "owner" });
    release();
    expect(await pending).toBe("rollback");
    expect(hidden).toBeNull();
    expect(await app.repos.threads.findById(ordinary.id)).not.toBeNull();
  });
});

const bindingConfiguration = {
  model: "mock-model",
  skills: { load: [], available: [] },
  namedTargets: [],
  permission: "edit" as const,
};
