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
  it("isolates caller mutation and retains authorized historical revisions", async () => {
    const store = fixture();
    const first = (await store.installSource(source("first"))).definitions[0];
    const next = (await store.installSource(source("next"))).definitions[0];
    const secret = (await store.installSource(source("secret"))).definitions[0];
    const selected = await store.selectRevision({
      ownerUserId: "owner",
      logicalKey: "a",
      revisionId: first.id,
    });
    if (!selected.ok) throw new Error("Fixture selection failed");
    first.definition.systemPrompt = "mutated";
    expect((await store.readRevision(first.id))?.definition.systemPrompt).toBe("first");
    await store.selectRevision({
      ownerUserId: "owner",
      logicalKey: "a",
      revisionId: next.id,
      expectedRevisionId: first.id,
    });
    expect((await store.readSelection("owner", selected.entry.id, first.id))?.revision.id).toBe(
      first.id,
    );
    expect(await store.readSelection("other", selected.entry.id, first.id)).toBeUndefined();
    expect(await store.readSelection("owner", selected.entry.id, secret.id)).toBeUndefined();
    expect(await store.bindThread("thread", first.id, bindingConfiguration, null)).toBe(true);
    expect(await store.bindThread("thread", next.id, bindingConfiguration, null)).toBe(false);
    expect(await store.removeOwnedEntry("other", selected.entry.id)).toBe(false);
    expect(await store.removeOwnedEntry("owner", selected.entry.id)).toBe(true);
    expect(await store.readSelection("owner", selected.entry.id, first.id)).toBeUndefined();
    expect((await store.readThreadBinding("thread"))?.revision?.id).toBe(first.id);
    expect(await store.restoreOwnedEntry("owner", selected.entry.id, next.id)).toBe(true);
    expect((await store.readSelection("owner", selected.entry.id, first.id))?.revision.id).toBe(
      first.id,
    );
  });

  it("rolls publication and binding back and allows later transactions to proceed", async () => {
    const store = fixture();
    await expect(
      store.transaction(async () => {
        await seedGeneralAgent(store, "model");
        const entry = await store.readCatalogEntry(null, "general");
        if (!entry) throw new Error("Missing General");
        await store.bindThread("thread", entry.selectedRevisionId, bindingConfiguration, null);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await store.readCatalogEntry(null, "general")).toBeUndefined();
    expect(await store.readThreadBinding("thread")).toBeUndefined();
    await seedGeneralAgent(store, "model");
    expect(await store.readCatalogEntry(null, "general")).toBeDefined();
    await expect(
      store.bindThread(
        "missing",
        "missing",
        {
          model: "test-model",
          skills: { load: [], available: [] },
          namedTargets: [],
        },
        null,
      ),
    ).rejects.toThrow("missing thread or revision");
  });

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

  it("serializes concurrent deduplication and whole-source publications", async () => {
    const store = fixture();
    const installs = await Promise.all(
      Array.from({ length: 8 }, () => store.installSource(source("same"))),
    );
    expect(new Set(installs.map((item) => item.packageRevisionId)).size).toBe(1);
    const catalog = createBoundAgentCatalog({
      defaultModel: () => "test-model",
      store,
      unavailableReasons: () => [],
    });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        catalog.installSystemSource({
          coordinate: "fixture",
          files: {
            "agents/a.md": `---\nname: Same\n---\nv${i}`,
            "agents/b.md": `---\nname: Same\n---\nv${i}`,
          },
        }),
      ),
    );
    const entries = await store.listCatalog({ userId: "owner", limit: 100 });
    const revisions = await Promise.all(
      entries.map((entry) => store.readRevision(entry.selectedRevisionId)),
    );
    expect(new Set(revisions.map((item) => item?.packageRevisionId)).size).toBe(1);
    const firstPage = await store.listCatalog({ userId: "owner", limit: 1 });
    const secondPage = await store.listCatalog({ userId: "owner", limit: 1, after: firstPage[0] });
    expect([...firstPage, ...secondPage]).toEqual(entries);
  });

  it("round-trips an agent-less binding and treats a differing overlay as a conflict", async () => {
    const store = fixture();
    const configuration = {
      model: "test-model",
      skills: { load: [], available: [] },
      namedTargets: [],
      tools: { read: "allow" as const },
    };
    const overlay = { systemPrompt: "Child prompt.", overrides: { effort: "low" as const } };
    expect(await store.bindThread("thread", null, configuration, overlay)).toBe(true);
    expect(await store.readThreadBinding("thread")).toEqual({
      revision: null,
      configuration,
      invocationOverlay: overlay,
    });
    expect(
      await store.bindThread("thread", null, configuration, { systemPrompt: "Different." }),
    ).toBe(false);
    expect(await store.readThreadBinding("thread")).toEqual({
      revision: null,
      configuration,
      invocationOverlay: overlay,
    });
  });

  it("labels an agent-less binding as the generic subagent and leaves no binding unnamed", async () => {
    const store = fixture();
    expect(store.boundAgent("thread")).toBeNull();
    await store.bindThread("thread", null, bindingConfiguration, null);
    expect(store.boundAgent("thread")).toEqual({
      agentDefinitionRevisionId: null,
      agentName: "Subagent",
    });
  });
});

const bindingConfiguration = {
  model: "test-model",
  skills: { load: [], available: [] },
  namedTargets: [],
};
