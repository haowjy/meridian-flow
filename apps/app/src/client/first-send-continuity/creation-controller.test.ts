/** Account-owned creation reconciles immutable attempts before admitting the first send. */
import "fake-indexeddb/auto";
import type { Project } from "@meridian/contracts/projects";
import type { Thread } from "@meridian/contracts/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { type CrossContextLockManager, deferred } from "@/core/cross-context-locks";
import { CreationController, type CreationPorts } from "./creation-controller";
import { type CreationAttempt, FirstSendContinuity } from "./first-send-continuity";

function setup() {
  const held = new Set<string>();
  const locks: CrossContextLockManager = {
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  vi.stubGlobal("navigator", { locks });
  const continuity = new FirstSendContinuity(crypto.randomUUID());
  const project: Project = {
    id: "project",
    userId: continuity.accountId,
    name: "Serial",
    title: "Serial",
    slug: "serial",
    isPersonal: false,
    systemPrompt: null,
    description: null,
    settings: {},
    lastActivityAt: "2026-09-11",
    createdAt: "2026-09-11",
    updatedAt: "2026-09-11",
    deletedAt: null,
  };
  const threads = new Map<string, Thread>();
  const makeThread = (attempt: CreationAttempt): Thread => ({
    id: attempt.threadId,
    projectId: attempt.projectId,
    workId: attempt.workId,
    userId: continuity.accountId,
    kind: "primary",
    status: "idle",
    title: attempt.title || null,
    slug: "opening",
    currentAgent: attempt.agent.slug,
    agentDefinitionRevisionId: attempt.agent.selection.definitionRevisionId,
    agentName: attempt.agent.name,
    activeLeafTurnId: null,
    parentThreadId: null,
    rootThreadId: attempt.threadId,
    spawnDepth: 0,
    spawnStatus: null,
    spawnResult: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-09-11",
    updatedAt: "2026-09-11",
    deletedAt: null,
  });
  const ports: CreationPorts = {
    accountSignal: new AbortController().signal,
    findProject: async () => project,
    createProject: async () => {
      throw new Error("Unexpected project creation");
    },
    findThread: async (_projectId, id) => threads.get(id) ?? null,
    createThread: async (attempt) => {
      const thread = makeThread(attempt);
      threads.set(thread.id, thread);
      return thread;
    },
    refusal: (error) =>
      error instanceof Error && error.message === "refused" ? "work_unavailable" : null,
    refreshChoices: async () => undefined,
    prepareAdmission: async () => ({ optimisticUserTurnId: "optimistic", cancel() {} }),
  };
  return { continuity, ports, threads, makeThread, project };
}
afterEach(() => vi.unstubAllGlobals());
const submission = () =>
  serializeComposerDraft(plainComposerDoc("Exact opening"), 4, { anchor: 6, head: 2 });

describe("CreationController", () => {
  it("keeps prospective Work and Agent with the draft across creation surface remounts", async () => {
    const { continuity, ports } = setup();
    const controller = new CreationController("project", continuity, ports);
    await controller.load();
    vi.spyOn(ports, "createThread");
    const draft = submission().draft;
    controller.updateDraft(draft);
    controller.updateChoices({ workId: "work-b" });
    controller.updateChoices({
      agent: {
        slug: "editor",
        name: "editor",
        selection: { catalogEntryId: "editor-entry", definitionRevisionId: "editor-revision" },
      },
    });
    await controller.reload();
    controller.dispose();
    const remounted = new CreationController("project", continuity, ports);
    await remounted.load();
    expect(remounted.getSnapshot().slot).toMatchObject({
      draft,
      choices: {
        workId: "work-b",
        agent: {
          slug: "editor",
          name: "editor",
          selection: { catalogEntryId: "editor-entry", definitionRevisionId: "editor-revision" },
        },
      },
    });
    expect(ports.createThread).not.toHaveBeenCalled();
    // A submit immediately after another choice must use the queued intent, not stale UI props.
    remounted.updateChoices({ workId: "work-a" });
    await remounted.submit({
      submission: submission(),
      title: "Exact opening",
      workId: "work-b",
      agent: {
        slug: "writer",
        name: "writer",
        selection: { catalogEntryId: "writer-entry", definitionRevisionId: "writer-revision" },
      },
    });
    expect(ports.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workId: "work-a",
        agent: {
          slug: "editor",
          name: "editor",
          selection: { catalogEntryId: "editor-entry", definitionRevisionId: "editor-revision" },
        },
      }),
    );
    remounted.dispose();
  });
  it("captures the selected Work and transfers typing that races server creation", async () => {
    const { continuity, ports, makeThread } = setup();
    const started = deferred<CreationAttempt>();
    const confirmed = deferred<Thread>();
    ports.createThread = async (attempt) => {
      started.resolve(attempt);
      return confirmed.promise;
    };
    const controller = new CreationController("project", continuity, ports);
    await controller.load();
    const envelope = submission();
    controller.updateDraft(envelope.draft);
    const pending = controller.submit({
      submission: envelope,
      title: "Exact opening",
      workId: "work-a",
      agent: {
        slug: "writer",
        name: "writer",
        selection: { catalogEntryId: "writer-entry", definitionRevisionId: "writer-revision" },
      },
    });
    const attempt = await started.promise;
    const later = { ...envelope.draft, revision: 9, selection: { anchor: 2, head: 1 } };
    controller.updateDraft(later);
    confirmed.resolve(makeThread(attempt));
    expect(await pending).toBe(true);
    expect(attempt.workId).toBe("work-a");
    const claim = await continuity.findForThread("project", attempt.threadId);
    expect(claim?.record).toMatchObject({ envelope, latestDraft: later });
    if (!claim) throw new Error("Missing admission");
    expect(await continuity.retire(claim.record)).toBe(true);
    expect(controller.getSnapshot().slot).toMatchObject({ draft: null, attempt: null });
    controller.dispose();
  });

  it("reconciles an uncertain committed thread without allocating or creating another", async () => {
    const { continuity, ports, threads, makeThread } = setup();
    const create = vi.fn(async (attempt: CreationAttempt) => {
      const thread = makeThread(attempt);
      threads.set(thread.id, thread);
      throw new Error("Response lost after commit");
    });
    ports.createThread = create;
    const controller = new CreationController("project", continuity, ports);
    await controller.load();
    const envelope = submission();
    controller.updateDraft(envelope.draft);
    expect(
      await controller.submit({
        submission: envelope,
        title: "Exact opening",
        workId: null,
        agent: {
          slug: "writer",
          name: "writer",
          selection: { catalogEntryId: "writer-entry", definitionRevisionId: "writer-revision" },
        },
      }),
    ).toBe(true);
    const attemptId = controller.getSnapshot().slot?.attempt?.attemptId;
    controller.dispose();
    const resumed = new CreationController("project", continuity, ports);
    await resumed.load();
    expect(await resumed.retry()).toBe(true);
    expect(resumed.getSnapshot().slot?.attempt?.attemptId).toBe(attemptId);
    expect(create).toHaveBeenCalledTimes(1);
    resumed.dispose();
  });

  it("reserves the exact revision before I/O and ignores replacement choices on ambiguous retry", async () => {
    const { continuity, ports, makeThread } = setup();
    const original = {
      name: "Writer",
      slug: "writer",
      selection: { catalogEntryId: "writer-entry", definitionRevisionId: "writer-v1" },
    };
    const replacement = {
      ...original,
      selection: { ...original.selection, definitionRevisionId: "writer-v2" },
    };
    let reserved: CreationAttempt | undefined;
    ports.createThread = vi.fn(async (attempt) => {
      expect((await continuity.readCreation("project")).attempt?.agent).toEqual(original);
      reserved = attempt;
      throw new Error("Connection lost before outcome is known");
    });
    const first = new CreationController("project", continuity, ports);
    await first.load();
    expect(
      await first.submit({
        submission: submission(),
        title: "Opening",
        workId: null,
        agent: original,
      }),
    ).toBe(false);
    expect(first.getSnapshot().slot?.attempt?.phase).toBe("ambiguous");
    first.dispose();

    ports.createThread = vi.fn(async (attempt) => {
      expect(attempt.threadId).toBe(reserved?.threadId);
      expect(attempt.agent).toEqual(original);
      return makeThread(attempt);
    });
    const resumed = new CreationController("project", continuity, ports);
    await resumed.load();
    expect(await resumed.retry({ workId: null, agent: replacement })).toBe(true);
    expect(resumed.getSnapshot().slot?.attempt?.agent).toEqual(original);
    resumed.dispose();
  });

  it.each([
    "abort",
    "conflict",
  ] as const)("rolls back only the prepared optimistic turn after publication %s", async (failure) => {
    const { continuity, ports } = setup();
    const projected = new Set<string>();
    ports.prepareAdmission = async () => {
      const id = crypto.randomUUID();
      projected.add(id);
      return {
        optimisticUserTurnId: id,
        cancel: () => {
          projected.delete(id);
        },
      };
    };
    const publish = vi.spyOn(continuity, "publishCreation");
    if (failure === "abort") publish.mockRejectedValueOnce(new Error("IndexedDB abort"));
    else
      publish.mockImplementationOnce(async (projectId) => ({
        kind: "conflict",
        slot: await continuity.readCreation(projectId),
      }));
    const controller = new CreationController("project", continuity, ports);
    await controller.load();
    const envelope = submission();
    controller.updateDraft(envelope.draft);
    expect(
      await controller.submit({
        submission: envelope,
        title: "Opening",
        workId: null,
        agent: {
          slug: "writer",
          name: "writer",
          selection: { catalogEntryId: "writer-entry", definitionRevisionId: "writer-revision" },
        },
      }),
    ).toBe(false);
    expect(projected.size).toBe(0);
    expect(await controller.retry()).toBe(true);
    expect(projected.size).toBe(1);
    const attempt = controller.getSnapshot().slot?.attempt;
    if (!attempt) throw new Error("Missing attempt");
    const admission = await continuity.peek({
      projectId: "project",
      threadId: attempt.threadId,
      submissionId: envelope.submissionId,
    });
    expect(projected.has(admission?.optimisticUserTurnId ?? "")).toBe(true);
    controller.dispose();
  });

  it("starts over only after mismatch without deleting the mismatched entity or draft", async () => {
    const { continuity, ports, threads, makeThread } = setup();
    ports.createThread = async (attempt) => {
      const thread = { ...makeThread(attempt), agentDefinitionRevisionId: "different-revision" };
      threads.set(thread.id, thread);
      return thread;
    };
    const controller = new CreationController("project", continuity, ports);
    await controller.load();
    const envelope = submission();
    controller.updateDraft(envelope.draft);
    expect(
      await controller.submit({
        submission: envelope,
        title: "Opening",
        workId: null,
        agent: {
          slug: "writer",
          name: "writer",
          selection: { catalogEntryId: "writer-entry", definitionRevisionId: "writer-revision" },
        },
      }),
    ).toBe(false);
    expect(controller.getSnapshot().slot?.attempt?.phase).toBe("mismatched");
    await controller.startOver();
    expect(controller.getSnapshot().slot).toMatchObject({ attempt: null, draft: envelope.draft });
    expect(threads.size).toBe(1);
    controller.dispose();
  });

  it("recovers a lost new-project response by its original owned ID", async () => {
    const { continuity, ports, project } = setup();
    let saved: Project | null = null;
    ports.findProject = async (id) => (saved?.id === id ? saved : null);
    const create = vi.fn(async (id: string, title: string) => {
      saved = { ...project, id, title, name: title };
      throw new Error("Response lost after commit");
    });
    ports.createProject = create;
    const controller = new CreationController(null, continuity, ports);
    await controller.load();
    const envelope = submission();
    controller.updateDraft(envelope.draft);
    expect(
      await controller.submit({
        submission: envelope,
        title: "Opening",
        workId: null,
        agent: {
          slug: "writer",
          name: "writer",
          selection: { catalogEntryId: "writer-entry", definitionRevisionId: "writer-revision" },
        },
      }),
    ).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().slot?.attempt?.projectId).toBe(create.mock.calls[0]?.[0]);
    controller.dispose();
  });

  it("allows explicit choice repair only after a definite refusal", async () => {
    const { continuity, ports, makeThread } = setup();
    const attempted: CreationAttempt[] = [];
    const refresh = vi.fn(async () => undefined);
    ports.refreshChoices = refresh;
    ports.createThread = async (attempt) => {
      attempted.push(attempt);
      if (attempt.workId === "archived") throw new Error("refused");
      return makeThread(attempt);
    };
    const controller = new CreationController("project", continuity, ports);
    await controller.load();
    const envelope = submission();
    controller.updateDraft(envelope.draft);
    expect(
      await controller.submit({
        submission: envelope,
        title: "Exact opening",
        workId: "archived",
        agent: {
          slug: "writer",
          name: "writer",
          selection: { catalogEntryId: "writer-entry", definitionRevisionId: "writer-revision" },
        },
      }),
    ).toBe(false);
    expect(controller.getSnapshot().issue).toBe("refused");
    expect(refresh).toHaveBeenCalledWith("project", "work_unavailable");
    expect(
      await controller.retry({
        workId: null,
        agent: {
          slug: "writer",
          name: "writer",
          selection: { catalogEntryId: "writer-entry", definitionRevisionId: "writer-revision" },
        },
      }),
    ).toBe(true);
    expect(attempted[1]?.submission).toEqual(envelope);
    const admission = await continuity.findForThread("project", attempted[1]?.threadId ?? "");
    expect(admission?.record.latestDraft).toBeNull();
    expect(attempted[1]?.projectId).toBe(attempted[0]?.projectId);
    expect(attempted[1]?.threadId).not.toBe(attempted[0]?.threadId);
    controller.dispose();
  });
});

it("fences old-account creation synchronously while project lookup is in flight", async () => {
  const { continuity, ports } = setup();
  const account = new AbortController();
  ports.accountSignal = account.signal;
  let entered!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resolveLookup!: (value: Project | null) => void;
  ports.findProject = () => {
    entered();
    return new Promise((resolve) => {
      resolveLookup = resolve;
    });
  };
  ports.createProject = vi.fn();
  ports.createThread = vi.fn();
  ports.prepareAdmission = vi.fn();
  const controller = new CreationController(null, continuity, ports);
  await controller.load();
  const pending = controller.submit({
    title: "Old private draft",
    workId: null,
    agent: {
      slug: "default",
      name: "default",
      selection: { catalogEntryId: "default-entry", definitionRevisionId: "default-revision" },
    },
    submission: submission(),
  });
  await lookupStarted;
  account.abort();
  resolveLookup(null);
  await pending;
  expect(ports.createProject).not.toHaveBeenCalled();
  expect(ports.createThread).not.toHaveBeenCalled();
  expect(ports.prepareAdmission).not.toHaveBeenCalled();
  controller.dispose();
});
