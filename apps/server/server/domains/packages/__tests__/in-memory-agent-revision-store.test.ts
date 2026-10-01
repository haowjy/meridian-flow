/** Hermetic adapter contracts used by exact-binding application tests. */
import { describe, expect, it } from "vitest";
import { createInMemoryAgentRevisionStore } from "../adapters/in-memory-agent-revision-store.js";
import { createBoundAgentCatalog } from "../domain/bound-agent-catalog.js";
import { seedGeneralAgent } from "../domain/default-package-seeding.js";

const source = (body: string) => ({
  coordinate: "fixture",
  files: { "agents/a.md": `---\nname: A\n---\n${body}` },
});
const fixture = () =>
  createInMemoryAgentRevisionStore({ threadExists: async (id) => id === "thread" });

describe("in-memory Agent revisions", () => {
  it("starts a fresh transaction for deferred work after its originating transaction ends", async () => {
    const store = fixture();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deferred = Promise.resolve();
    await store.transaction(async () => {
      deferred = (async () => {
        await gate;
        await seedGeneralAgent(store, "deferred-model");
      })();
    });
    await seedGeneralAgent(store, "intervening-model");
    release();
    await deferred;
    const entry = await store.readCatalogEntry(null, "general");
    if (!entry) throw new Error("Missing General");
    expect((await store.readRevision(entry.selectedRevisionId))?.definition.metadata.model).toBe(
      "deferred-model",
    );
  });

  it("rejects a binding that resumes after its transaction rolled back", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = createInMemoryAgentRevisionStore({
      threadExists: async () => {
        await gate;
        return true;
      },
    });
    let escaped: Promise<unknown> = Promise.resolve();
    await expect(
      store.transaction(async () => {
        const first = (await store.installSource(source("rolled back"))).definitions[0];
        escaped = store
          .bindThread("thread", first.id, bindingConfiguration, null)
          .catch((error) => error.message);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    release();
    expect(await escaped).toBe("In-memory transaction already completed");
    const valid = (await store.installSource(source("valid"))).definitions[0];
    expect(await store.bindThread("thread", valid.id, bindingConfiguration, null)).toBe(true);
    expect((await store.readThreadBinding("thread"))?.revision?.id).toBe(valid.id);
  });

  it("rejects user-invocation denial in both catalog listing and exact primary selection", async () => {
    const store = fixture();
    const catalog = createBoundAgentCatalog({
      defaultModel: () => "test-model",
      store,
      unavailableReasons: () => [],
    });
    await catalog.installSystemSource({
      coordinate: "denied",
      files: {
        "agents/denied.md": "---\nmodel: available-model\nuser-invocable: false\n---\nPersona",
      },
    });
    const page = await catalog.list("owner", { limit: 100 });
    const item = page.agents[0];
    expect(item.unavailableReasons).toContain(
      "This Agent is unavailable for primary conversations",
    );
    expect(await catalog.resolvePrimary("owner", item.selection)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });
});

const bindingConfiguration = {
  model: "test-model",
  skills: { load: [], available: [] },
  namedTargets: [],
};
