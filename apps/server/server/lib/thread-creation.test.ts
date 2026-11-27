import { NO_OVERRIDES } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  createBoundAgentCatalog,
  generalAgentSource,
  noLevelFiles,
} from "../domains/packages/index.js";
import {
  createInMemoryProjectRepository,
  createInMemoryWorkRepository,
} from "../domains/projects/index.js";
import { WorkLifecycleUnavailableError } from "../shared/work-lifecycle-lock.js";
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
  const agentCatalog = createBoundAgentCatalog({
    modelFor: (name) => name ?? "test-model",
    store: app.agentRevisions,
    levelFiles: noLevelFiles,
    builtins: [generalAgentSource("fixture-model")],
    unavailableReasons: () => [],
    modelUnavailable: () => [],
  });
  const general = (await agentCatalog.list("owner", {})).agents.find(
    (agent) => agent.slug === "general",
  );
  if (!general?.selection) throw new Error("Missing General");
  const workRepo = createInMemoryWorkRepository();
  await workRepo.ensureNoWork(project.id);
  const deps = {
    projects,
    workRepo,
    threads: app.threadRepos.threads,
    threadWorks: app.threadRepos.threadWorks,
    transaction: app.threadRepos.transaction,
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
    agentSelection: general.selection,
    overrides: NO_OVERRIDES,
  };
  return { app, deps, args, projects };
}

describe("exact thread creation", () => {
  it("binds omitted and null workId to No Work", async () => {
    const { deps, args } = await fixture();
    const noWork = await deps.workRepo.findNoWork(args.projectId);
    if (!noWork) throw new Error("expected No Work");
    const created = await createThreadForProject(deps, args);
    await expect(deps.threadWorks.findPrimary(created.id)).resolves.toEqual({ workId: noWork.id });
    const omitted = await createThreadForProject(deps, {
      ...args,
      id: crypto.randomUUID(),
      workId: undefined,
    });
    await expect(deps.threadWorks.findPrimary(omitted.id)).resolves.toEqual({ workId: noWork.id });
  });

  it("starts a chat in its Work's default, and an explicit mode wins and becomes the default", async () => {
    const { deps, args } = await fixture();
    const work = await deps.workRepo.create({ projectId: args.projectId, name: "Rewrite" });
    await deps.workRepo.setDefaultAiWriteMode(work.id, "draft");
    const create = (aiWriteMode?: "direct" | "draft") =>
      createThreadForProject(deps, {
        ...args,
        id: crypto.randomUUID(),
        workId: work.id,
        aiWriteMode,
      });

    const copied = await create();
    expect(copied.aiWriteMode).toBe("draft");
    const explicit = await create("direct");
    expect(explicit.aiWriteMode).toBe("direct");
    expect((await deps.workRepo.findById(work.id))?.defaultAiWriteMode).toBe("direct");
    expect((await deps.threads.findById(copied.id))?.aiWriteMode).toBe("draft");
    expect((await create()).aiWriteMode).toBe("direct");
  });

  it("binds the winner for the slug and recovers the same binding without consulting the catalog", async () => {
    const { app, deps, args } = await fixture();
    const created = await createThreadForProject(deps, args);
    expect(created.agentName).toBe("General");
    expect(created.ref).toBe("c1");
    expect((await app.threadRepos.threads.findById(created.id))?.agentDefinitionRevisionId).toBe(
      created.agentDefinitionRevisionId,
    );
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
      { ...args, title: "Different task" },
    );
    expect(recovered).toEqual(created);
  });

  it("does not resurrect a deleted thread on same-user retry", async () => {
    const { deps, args } = await fixture();
    const created = await createThreadForProject(deps, args);
    await deps.threads.setTrashState(created.id, "deleted");
    await expect(createThreadForProject(deps, args)).rejects.toMatchObject({
      statusCode: 404,
      data: {
        __meridianInterruptEnvelope: {
          error: {
            code: "thread_deleted",
            details: { authenticatedUserId: args.userId },
          },
        },
      },
    });
    expect(await deps.threads.findById(created.id)).toBeNull();
    expect((await deps.threads.lockByIdIncludingDeleted(created.id))?.deletedAt).not.toBeNull();
  });

  it("conflicts when the same user reuses the id in another project", async () => {
    const { deps, args, projects } = await fixture();
    await createThreadForProject(deps, args);
    const other = await projects.create({ userId: "owner", title: "Other" });
    await expect(
      createThreadForProject(deps, { ...args, projectId: other.id }),
    ).rejects.toBeInstanceOf(ThreadCreationConflictError);
  });

  it("reconciles concurrent same-ID creates to the one committed binding", async () => {
    const { app, deps, args } = await fixture();
    const [first, second] = await Promise.all([
      createThreadForProject(deps, args),
      createThreadForProject(deps, args),
    ]);
    expect(second).toEqual(first);
    expect((await app.threadRepos.threads.listByProject(args.projectId)).length).toBe(1);
    expect((await app.agentRevisions.readThreadBinding(args.id))?.revision?.slug).toBe("general");
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
    expect(await app.threadRepos.threads.findById(args.id)).toBeNull();
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
            async bindThread(id, revision, configuration, invocationOverlay) {
              await app.agentRevisions.bindThread(id, revision, configuration, invocationOverlay);
              throw new Error("after binding");
            },
          },
        },
        args,
      ),
    ).rejects.toThrow("after binding");
    expect(await app.threadRepos.threads.findById(args.id)).toBeNull();
    expect(await app.agentRevisions.readThreadBinding(args.id)).toBeUndefined();
  });

  it("refuses an unknown Agent and an unavailable Work without creating a thread", async () => {
    const { app, deps, args } = await fixture();
    await expect(
      createThreadForProject(deps, {
        ...args,
        agentSelection: { slug: "no-such-agent", definitionRevisionId: crypto.randomUUID() },
      }),
    ).rejects.toThrow("Agent not found");
    await expect(createThreadForProject(deps, { ...args, workId: "missing-work" })).rejects.toThrow(
      "Work is not available",
    );
    expect(await app.threadRepos.threads.findById(args.id)).toBeNull();
  });
});
