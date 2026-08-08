/** Work command wiring protocol coverage. */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../domains/observability/index.js";
import { createInMemoryProjectPreferencesRepository } from "../domains/preferences/index.js";
import { createInMemoryWorkRepository, WorkDeleteBlockedError } from "../domains/projects/index.js";
import type { ToolHandlerContext } from "../domains/runtime/index.js";
import { createWiredCoreToolRegistrations } from "./wired-core-tools.js";

type TestWriteHandler = (input: unknown, ctx: ToolHandlerContext) => Promise<unknown>;
describe("wired work tool", () => {
  async function setup(kind: "primary" | "subagent" = "primary", draftMode = false) {
    const baseWorks = createInMemoryWorkRepository();
    const current = await baseWorks.create({
      id: "00000000-0000-4000-8000-000000000011",
      projectId: "project-1",
      createdByUserId: "user-1",
      name: "Current",
    });
    const target = await baseWorks.create({
      id: "00000000-0000-4000-8000-000000000012",
      projectId: "project-1",
      createdByUserId: "user-1",
      name: "Target",
    });
    const works = draftMode
      ? {
          ...baseWorks,
          async findById(id: string) {
            const work = await baseWorks.findById(id as never);
            return work && id === current.id ? { ...work, aiWriteMode: "draft" as const } : work;
          },
        }
      : baseWorks;
    let primaryWorkId = current.id;
    const invalidateThread = vi.fn(async () => {});
    const threadChanged = vi.fn(async () => {});
    const preferences = createInMemoryProjectPreferencesRepository();
    const registrations = createWiredCoreToolRegistrations({
      threads: {
        findById: async () =>
          ({
            id: "thread-1",
            projectId: "project-1",
            userId: "user-1",
            kind,
          }) as never,
        listByWork: async () => [
          {
            id: "recent-thread",
            title: "Revision chat",
            updatedAt: "2026-08-06T12:00:00.000Z",
            status: "active",
            composedSystemPrompt: "large frozen prompt",
          },
        ],
      } as never,
      threadWorks: {
        findPrimary: async () => ({ workId: primaryWorkId }),
        rebindPrimary: async (_threadId, workId) => {
          const previousWorkId = primaryWorkId;
          primaryWorkId = workId;
          return { previousWorkId, changed: previousWorkId !== workId };
        },
      },
      works: works as never,
      preferences,
      workContextUpdates: { projectChanged: async () => {}, threadChanged },
      drafts: { draftReview: { list: async () => [{ draftId: "draft-1" }] } } as never,
      contextPorts: {} as never,
      documentSync: {
        agentEdit: () => ({ invalidateThread }) as never,
      } as never,
      responseWrites: { trackStagedCreate: () => {} } as never,
      eventSink: createInMemoryEventSink(),
    });
    const registration = registrations.find((candidate) => candidate.definition.name === "work");
    if (registration?.execution.type !== "server") throw new Error("missing work");
    return {
      handler: registration.execution.handler as TestWriteHandler,
      current,
      target,
      works: baseWorks,
      preferences,
      invalidateThread,
      threadChanged,
    };
  }

  it("dispatches all six branches and journals mutation receipts", async () => {
    const { handler, target } = await setup();
    const ctx = toolContext();
    await expect(handler({ command: "list" }, ctx)).resolves.toHaveLength(2);
    await expect(handler({ command: "show", work: target.slug }, ctx)).resolves.toMatchObject({
      work: { slug: "target", name: "Target" },
      recentThreads: [
        {
          title: "Revision chat",
          updatedAt: "2026-08-06T12:00:00.000Z",
          status: "active",
        },
      ],
      drafts: [{ draftId: "draft-1" }],
    });
    await expect(handler({ command: "create", name: "New Work" }, ctx)).resolves.toMatchObject({
      metadata: {
        workReceipt: {
          operation: "create",
          category: "mutate",
          changed: true,
          inverse: { command: "delete" },
        },
        workContextChanged: true,
      },
    });
    await expect(
      handler({ command: "update", work: target.slug, name: "Target Revised" }, ctx),
    ).resolves.toMatchObject({
      output: { name: "Target Revised" },
      metadata: {
        workReceipt: { operation: "update", changed: true, inverse: { command: "update" } },
        workContextChanged: true,
      },
    });
    await expect(handler({ command: "switch", work: target.slug }, ctx)).resolves.toMatchObject({
      metadata: { workReceipt: { operation: "switch", category: "binding", changed: true } },
    });
    const created = (await handler({ command: "create", name: "Delete Me" }, ctx)) as {
      output: { slug: string };
    };
    await expect(
      handler({ command: "delete", work: created.output.slug }, ctx),
    ).resolves.toMatchObject({
      metadata: {
        workReceipt: { operation: "delete", changed: true, inverse: { command: "restore" } },
        workContextChanged: true,
      },
    });

    const [listOutput, showOutput, switchResult] = await Promise.all([
      handler({ command: "list" }, ctx),
      handler({ command: "show", work: target.slug }, ctx),
      handler({ command: "switch", work: target.slug }, ctx),
    ]);
    const outputs = [listOutput, showOutput, (switchResult as { output: unknown }).output];
    expect(JSON.stringify(outputs)).not.toMatch(
      /00000000-0000-4000-8000-00000000001[12]|project-1|user-1|large frozen prompt/,
    );
  });

  it("returns actionable unknown-slug errors and rejects extra schema fields", async () => {
    const { handler } = await setup();
    await expect(
      handler({ command: "show", work: "missing" }, toolContext()),
    ).resolves.toMatchObject({
      isError: true,
      output: {
        code: "work_not_found",
        details: { validWorkSlugs: expect.arrayContaining(["current", "target"]) },
      },
    });
    await expect(
      handler({ command: "list", unexpected: true }, toolContext()),
    ).resolves.toMatchObject({ isError: true });
  });

  it("returns a coded delete refusal with the blocking content kind", async () => {
    const { handler, target, works } = await setup();
    vi.spyOn(works, "softDelete").mockRejectedValueOnce(new WorkDeleteBlockedError("documents"));
    await expect(
      handler({ command: "delete", work: target.slug }, toolContext()),
    ).resolves.toMatchObject({
      isError: true,
      output: {
        code: "work_delete_blocked",
        details: { blockingContentKind: "documents" },
      },
    });
  });

  it("marks changed switches for post-result delivery and only sticks primary switches", async () => {
    const primary = await setup("primary", true);
    await expect(
      primary.handler({ command: "switch", work: primary.target.slug }, toolContext()),
    ).resolves.toMatchObject({ metadata: { workContextChanged: true } });
    expect(primary.invalidateThread).not.toHaveBeenCalled();
    expect(primary.threadChanged).toHaveBeenCalledOnce();
    await expect(primary.preferences.getCurrentWorkId("user-1", "project-1")).resolves.toBe(
      primary.target.id,
    );

    const subagent = await setup("subagent", false);
    await subagent.handler({ command: "switch", work: subagent.target.slug }, toolContext());
    expect(subagent.invalidateThread).not.toHaveBeenCalled();
    await expect(subagent.preferences.getCurrentWorkId("user-1", "project-1")).resolves.toBeNull();
  });

  it("keeps an already-current switch side-effect free beyond its receipt", async () => {
    const fixture = await setup();
    await fixture.handler({ command: "switch", work: fixture.target.slug }, toolContext());
    expect(fixture.threadChanged).toHaveBeenCalledOnce();
    await expect(
      fixture.handler({ command: "switch", work: fixture.target.slug }, toolContext()),
    ).resolves.toMatchObject({
      metadata: {
        workReceipt: { operation: "switch", changed: false, inverse: null },
      },
    });
    expect(fixture.threadChanged).toHaveBeenCalledOnce();
  });

  it("captures repeated updates from the locked transition that actually commits", async () => {
    const fixture = await setup();
    const first = await fixture.handler(
      { command: "update", work: fixture.target.slug, name: "Target B" },
      toolContext(),
    );
    const second = await fixture.handler(
      { command: "update", work: fixture.target.slug, name: "Target C" },
      toolContext(),
    );

    expect(first).toMatchObject({
      metadata: { workReceipt: { before: { name: "Target" }, after: { name: "Target B" } } },
    });
    expect(second).toMatchObject({
      metadata: { workReceipt: { before: { name: "Target B" }, after: { name: "Target C" } } },
    });
  });

  it("emits no inverse or projection invalidation for a content-identical update", async () => {
    const fixture = await setup();
    const original = await fixture.works.findById(fixture.target.id);

    await expect(
      fixture.handler(
        {
          command: "update",
          work: fixture.target.slug,
          name: fixture.target.name,
          goal: "",
          description: "",
          status: fixture.target.status,
        },
        toolContext(),
      ),
    ).resolves.toMatchObject({
      output: {
        name: fixture.target.name,
        goal: null,
        description: null,
        status: fixture.target.status,
        updatedAt: original?.updatedAt,
        lastActivityAt: original?.lastActivityAt,
      },
      metadata: {
        workReceipt: {
          operation: "update",
          changed: false,
          inverse: null,
        },
      },
    });
    expect(fixture.threadChanged).not.toHaveBeenCalled();
    expect(fixture.invalidateThread).not.toHaveBeenCalled();
  });

  it("captures a concurrent update as the exact before state", async () => {
    const fixture = await setup();
    const lockById = fixture.works.lockById.bind(fixture.works);
    vi.spyOn(fixture.works, "lockById").mockImplementationOnce(async (workId) => {
      await fixture.works.update(workId, { name: "Concurrent B" });
      return lockById(workId);
    });

    await expect(
      fixture.handler(
        { command: "update", work: fixture.target.slug, name: "Command C" },
        toolContext(),
      ),
    ).resolves.toMatchObject({
      metadata: {
        workReceipt: { before: { name: "Concurrent B" }, after: { name: "Command C" } },
      },
    });
  });

  it("records a delete that lost the lifecycle race as a no-op", async () => {
    const fixture = await setup();
    const lockById = fixture.works.lockById.bind(fixture.works);
    vi.spyOn(fixture.works, "lockById").mockImplementationOnce(async (workId) => {
      await fixture.works.softDelete(workId);
      return lockById(workId);
    });

    await expect(
      fixture.handler({ command: "delete", work: fixture.target.slug }, toolContext()),
    ).resolves.toMatchObject({
      metadata: { workReceipt: { operation: "delete", changed: false, inverse: null } },
    });
  });
});
function toolContext(): ToolHandlerContext {
  return {
    signal: new AbortController().signal,
    threadId: "thread-a",
    turnId: "turn-a",
    agentSlug: null,
    toolCallId: undefined,
  };
}
