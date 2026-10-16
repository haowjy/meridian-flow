/** Consolidated test contracts; each block retains its original fixture scope. */

import { HTTPError } from "nitro/h3";
import { describe as __mergedSuite, expect, it } from "vitest";
import {
  AgentSelectionError,
  createBoundAgentCatalog,
  seedGeneralAgent,
} from "../domains/packages/index.js";
import {
  createInMemoryProjectRepository,
  createInMemoryWorkRepository,
  WorkLifecycleUnavailableError,
} from "../domains/projects/index.js";
import { createInMemoryAppServices } from "./compose.js";
import interruptErrorHandler from "./interrupt-error-handler.js";
import {
  createThreadForProject,
  InvalidWorkAttachmentError,
  ThreadCreationConflictError,
  ThreadCreationNotFoundError,
} from "./thread-creation.js";
import { throwThreadCreationError } from "./thread-creation-http.js";

__mergedSuite("thread-creation.test.ts", () => {
  // Merged from apps/server/server/lib/thread-creation.test.ts.
  async function fixture() {
    const app = createInMemoryAppServices();
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "owner", title: "Agents" });
    await seedGeneralAgent(app.agentRevisions, "fixture-model");
    const entry = await app.agentRevisions.readCatalogEntry(null, "general");
    if (!entry) throw new Error("Missing General");
    const agentCatalog = createBoundAgentCatalog({
      defaultModel: () => "test-model",
      store: app.agentRevisions,
      unavailableReasons: () => [],
    });
    const workRepo = createInMemoryWorkRepository();
    await workRepo.ensureNoWork(project.id);
    const deps = {
      projects,
      workRepo,
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
    return { app, deps, args, projects };
  }

  __mergedSuite("exact thread creation", () => {
    it("binds omitted and null workId to No Work", async () => {
      const { deps, args } = await fixture();
      const noWork = await deps.workRepo.findNoWork(args.projectId);
      if (!noWork) throw new Error("expected No Work");
      const created = await createThreadForProject(deps, args);
      await expect(deps.threadWorks.findPrimary(created.id)).resolves.toEqual({
        workId: noWork.id,
      });
      const omitted = await createThreadForProject(deps, {
        ...args,
        id: crypto.randomUUID(),
        workId: undefined,
      });
      await expect(deps.threadWorks.findPrimary(omitted.id)).resolves.toEqual({
        workId: noWork.id,
      });
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
      // The Work's earlier chat keeps the mode it started with.
      expect((await deps.threads.findById(copied.id))?.aiWriteMode).toBe("draft");
      expect((await create()).aiWriteMode).toBe("direct");
    });
    it("binds the reserved revision and recovers it before prospective catalog eligibility", async () => {
      const { app, deps, args } = await fixture();
      const created = await createThreadForProject(deps, args);
      expect(created.agentDefinitionRevisionId).toBe(args.agentSelection.definitionRevisionId);
      expect(created.agentName).toBe("General");
      expect(created.ref).toBe("c1");
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
    it("does not confirm another user's thread id", async () => {
      const { deps, args, projects } = await fixture();
      await createThreadForProject(deps, args);
      const strangerProject = await projects.create({ userId: "stranger", title: "Stranger" });
      await expect(
        createThreadForProject(deps, {
          ...args,
          projectId: strangerProject.id,
          userId: "stranger",
        }),
      ).rejects.toBeInstanceOf(ThreadCreationNotFoundError);
    });
    it("reconciles concurrent same-ID creates to the one committed binding", async () => {
      const { app, deps, args } = await fixture();
      const [first, second] = await Promise.all([
        createThreadForProject(deps, args),
        createThreadForProject(deps, args),
      ]);
      expect(second).toEqual(first);
      expect((await app.repos.threads.listByProject(args.projectId)).length).toBe(1);
      expect((await app.agentRevisions.readThreadBinding(args.id))?.revision?.id).toBe(
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
              async bindThread(id, revision, configuration, invocationOverlay) {
                await app.agentRevisions.bindThread(id, revision, configuration, invocationOverlay);
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
      await expect(
        createThreadForProject(deps, { ...args, workId: "missing-work" }),
      ).rejects.toThrow("Work is not available");
      expect(await app.repos.threads.findById(args.id)).toBeNull();
    });
  });
});

__mergedSuite("thread-creation-http.test.ts", () => {
  // Merged from apps/server/server/lib/thread-creation-http.test.ts.
  __mergedSuite("root creation transport", () => {
    it.each([
      [new AgentSelectionError("revision"), "agent_not_found"],
      [new InvalidWorkAttachmentError("Work unavailable"), "work_unavailable"],
    ])("serializes the shared refusal %s", async (error, code) => {
      let response: Response | undefined;
      try {
        throwThreadCreationError(error);
      } catch (mapped) {
        response = interruptErrorHandler(mapped, undefined);
      }
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({ kind: "error", error: { code } });
    });
    it("preserves infrastructure failures and maps identity conflicts to 409 or 404", () => {
      const failure = new Error("database unavailable");
      expect(() => throwThreadCreationError(failure)).toThrow(failure);
      try {
        throwThreadCreationError(new ThreadCreationConflictError());
      } catch (error) {
        expect(HTTPError.isError(error) && error.status).toBe(409);
      }
      try {
        throwThreadCreationError(new ThreadCreationNotFoundError());
      } catch (error) {
        expect(HTTPError.isError(error) && error.status).toBe(404);
      }
    });
  });
});
