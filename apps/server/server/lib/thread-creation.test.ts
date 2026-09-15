/** Exact root binding, committed recovery, and atomic failure in the app transaction. */
import { describe, expect, it } from "vitest";
import { createBoundAgentCatalog, seedGeneralAgent } from "../domains/packages/index.js";
import {
  createInMemoryProjectRepository,
  createInMemoryWorkRepository,
  WorkLifecycleUnavailableError,
} from "../domains/projects/index.js";
import { createInMemoryAppServices } from "./compose.js";
import {
  createThreadForProject,
  InvalidWorkAttachmentError,
  ThreadCreationConflictError,
} from "./thread-creation.js";

async function fixture() {
  const app = createInMemoryAppServices();
  const projects = createInMemoryProjectRepository();
  const project = await projects.create({ userId: "owner", title: "Agents" });
  await seedGeneralAgent(app.agentRevisions, "fixture-model");
  const entry = await app.agentRevisions.readCatalogEntry(null, "general");
  if (!entry) throw new Error("Missing General");
  const agentCatalog = createBoundAgentCatalog({
    store: app.agentRevisions,
    unavailableReasons: () => [],
  });
  const deps = {
    projects,
    workRepo: createInMemoryWorkRepository(),
    threads: app.repos.threads,
    threadWorks: app.repos.threadWorks,
    transaction: app.repos.transaction,
    agentRevisions: app.agentRevisions,
    agentCatalog,
    eventSink: app.eventSink,
  };
  const args = {
    id: crypto.randomUUID(),
    projectId: project.id,
    userId: "owner",
    title: "Draft a scene",
    workId: null,
    agentSelection: { catalogEntryId: entry.id, definitionRevisionId: entry.selectedRevisionId },
  };
  return { app, deps, args };
}

describe("exact thread creation", () => {
  it("binds the reserved revision and recovers it before prospective catalog eligibility", async () => {
    const { app, deps, args } = await fixture();
    const created = await createThreadForProject(deps, args);
    expect(created.agentDefinitionRevisionId).toBe(args.agentSelection.definitionRevisionId);
    expect(created.agentName).toBe("General");
    expect((await app.repos.threads.findById(created.id))?.agentDefinitionRevisionId).toBe(
      args.agentSelection.definitionRevisionId,
    );
    await seedGeneralAgent(app.agentRevisions, "new-model");
    const recovered = await createThreadForProject(
      {
        ...deps,
        agentCatalog: {
          ...deps.agentCatalog,
          resolvePrimary: async () => {
            throw new Error("Recovery must not consult current eligibility");
          },
        },
      },
      args,
    );
    expect(recovered).toEqual(created);
    await expect(
      createThreadForProject(deps, { ...args, title: "Different task" }),
    ).rejects.toBeInstanceOf(ThreadCreationConflictError);
  });

  it("reconciles concurrent same-ID creates to the one committed binding", async () => {
    const { app, deps, args } = await fixture();
    const [first, second] = await Promise.all([
      createThreadForProject(deps, args),
      createThreadForProject(deps, args),
    ]);
    expect(second).toEqual(first);
    expect((await app.repos.threads.listByProject(args.projectId)).length).toBe(1);
    expect((await app.agentRevisions.readThreadBinding(args.id))?.id).toBe(
      args.agentSelection.definitionRevisionId,
    );
  });

  it("refuses Work loss at locked attachment after rolling creation back", async () => {
    const { app, deps, args } = await fixture();
    const work = await deps.workRepo.create({ projectId: args.projectId, name: "Arc" });
    await expect(
      createThreadForProject(
        {
          ...deps,
          threadWorks: {
            ...deps.threadWorks,
            async addMembership() {
              throw new WorkLifecycleUnavailableError(work.id, "archived");
            },
          },
        },
        { ...args, workId: work.id },
      ),
    ).rejects.toBeInstanceOf(InvalidWorkAttachmentError);
    expect(await app.repos.threads.findById(args.id)).toBeNull();
    expect(await app.agentRevisions.readThreadBinding(args.id)).toBeUndefined();
  });

  it("rolls thread and binding back when a failure follows binding", async () => {
    const { app, deps, args } = await fixture();
    await expect(
      createThreadForProject(
        {
          ...deps,
          agentRevisions: {
            ...app.agentRevisions,
            async bindThread(id, revision) {
              await app.agentRevisions.bindThread(id, revision);
              throw new Error("after binding");
            },
          },
        },
        args,
      ),
    ).rejects.toThrow("after binding");
    expect(await app.repos.threads.findById(args.id)).toBeNull();
    expect(await app.agentRevisions.readThreadBinding(args.id)).toBeUndefined();
  });

  it("refuses another account's catalog selection and unavailable Work without creating a thread", async () => {
    const { app, deps, args } = await fixture();
    const privateEntry = await app.agentRevisions.selectRevision({
      ownerUserId: "other",
      logicalKey: "private",
      revisionId: args.agentSelection.definitionRevisionId,
    });
    if (!privateEntry.ok) throw new Error("Fixture catalog failed");
    await expect(
      createThreadForProject(deps, {
        ...args,
        agentSelection: { ...args.agentSelection, catalogEntryId: privateEntry.entry.id },
      }),
    ).rejects.toThrow("Agent not found");
    await expect(createThreadForProject(deps, { ...args, workId: "missing-work" })).rejects.toThrow(
      "Work is not available",
    );
    expect(await app.repos.threads.findById(args.id)).toBeNull();
  });
});
