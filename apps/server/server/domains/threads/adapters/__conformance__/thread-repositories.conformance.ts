/**
 * Shared conformance suite for the thread repository ports: every adapter set
 * (drizzle, in-memory) runs this same behavioral spec so they stay
 * interchangeable. Imported by each adapter's own test file.
 */
import { describe, expect, it } from "vitest";
import type { ProjectRepository } from "../../../projects/ports/project-repository.js";
import type { WorkRepository } from "../../../projects/ports/work-repository.js";
import { ThreadLifecycleNotSupportedError } from "../../domain/thread-create.js";
import type { ThreadRepositories } from "../../ports/repositories.js";

export const THREAD_REPOSITORIES_CONFORMANCE_USER_ID = "00000000-0000-4000-9000-000000000401";

export interface ThreadRepositoriesFixture {
  repos: ThreadRepositories;
  projects: ProjectRepository;
  works: WorkRepository;
}

export function describeThreadRepositoriesConformance(
  name: string,
  makeFixture: () => ThreadRepositoriesFixture | Promise<ThreadRepositoriesFixture>,
): void {
  describe(`ThreadRepositories conformance: ${name}`, () => {
    it("creates a root thread and rejects spawn-shaped input", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });

      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });
      expect(thread).toMatchObject({ id: thread.id, status: "idle", rootThreadId: thread.id });

      await expect(
        repos.threads.create({
          userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
          projectId: project.id,
          parentThreadId: thread.id,
        }),
      ).rejects.toBeInstanceOf(ThreadLifecycleNotSupportedError);
    });

    it("finds threads by id and lists by user and project", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });

      expect(await repos.threads.findById(thread.id)).toMatchObject({
        id: thread.id,
        status: "idle",
      });
      await expect(
        repos.threads.listByUser(THREAD_REPOSITORIES_CONFORMANCE_USER_ID),
      ).resolves.toHaveLength(1);
      await expect(repos.threads.listByProject(project.id)).resolves.toHaveLength(1);
    });

    it("projects work title, waiting state, running turn, and listByWork", async () => {
      const { repos, projects, works } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const otherProject = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Other Project",
      });
      const work = await works.create({
        projectId: project.id,
        title: "Analysis Work",
      });
      const otherWork = await works.create({
        projectId: project.id,
        title: "Other Work",
      });
      const crossProjectWork = await works.create({
        projectId: otherProject.id,
        title: "Cross Project",
      });

      const waitingThread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
        title: "Waiting",
      });
      await repos.threadWorks.addMembership(waitingThread.id, work.id, true);
      const waitingUserTurn = await repos.turns.create({
        threadId: waitingThread.id,
        role: "user",
        status: "complete",
      });
      await repos.turns.create({
        threadId: waitingThread.id,
        prevTurnId: waitingUserTurn.id,
        role: "assistant",
        status: "complete",
      });

      const runningThread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
        title: "Running",
      });
      await repos.threadWorks.addMembership(runningThread.id, work.id, true);
      const runningAssistantTurn = await repos.turns.create({
        threadId: runningThread.id,
        role: "assistant",
        status: "streaming",
      });
      await repos.threads.updateStatus(runningThread.id, "active");

      const otherWorkThread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
        title: "Other Work Thread",
      });
      await repos.threadWorks.addMembership(otherWorkThread.id, otherWork.id, true);
      const crossProjectThread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: otherProject.id,
        title: "Cross Project Thread",
      });
      await repos.threadWorks.addMembership(crossProjectThread.id, crossProjectWork.id, true);

      const projectThreads = await repos.threads.listByProject(project.id);
      const waiting = projectThreads.find((thread) => thread.id === waitingThread.id);
      const running = projectThreads.find((thread) => thread.id === runningThread.id);
      expect(waiting).toMatchObject({
        work: { id: work.id, title: "Analysis Work" },
        waitingForUser: true,
        runningTurnId: null,
      });
      expect(running).toMatchObject({
        work: { id: work.id, title: "Analysis Work" },
        waitingForUser: false,
        runningTurnId: runningAssistantTurn.id,
      });

      const workThreads = await repos.threads.listByWork(project.id, work.id);
      expect(workThreads.map((thread) => thread.id).sort()).toEqual(
        [waitingThread.id, runningThread.id].sort(),
      );
      await expect(repos.threads.listByWork(otherProject.id, work.id)).resolves.toEqual([]);
      expect(projectThreads.map((thread) => thread.id)).toContain(otherWorkThread.id);
    });

    it("updates thread status", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });

      const active = await repos.threads.updateStatus(thread.id, "active");
      expect(active.status).toBe("active");
    });

    it("soft-deletes and restores threads idempotently", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });

      const deleted = await repos.threads.softDelete(thread.id);
      expect(deleted.deletedAt).not.toBeNull();
      expect(await repos.threads.findById(thread.id)).toBeNull();
      await expect(repos.threads.listByProject(project.id)).resolves.toEqual([]);

      const deletedAgain = await repos.threads.softDelete(thread.id);
      expect(deletedAgain.deletedAt).toEqual(deleted.deletedAt);

      const restored = await repos.threads.restore(thread.id);
      expect(restored.deletedAt).toBeNull();
      expect(await repos.threads.findById(thread.id)).toMatchObject({ id: thread.id });

      const restoredAgain = await repos.threads.restore(thread.id);
      expect(restoredAgain.deletedAt).toBeNull();
    });

    it("hides threads when the project is soft-deleted", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });

      await projects.softDelete(project.id);
      expect(await repos.threads.findById(thread.id)).toBeNull();
      await expect(repos.threads.listByProject(project.id)).resolves.toEqual([]);

      await projects.restore(project.id);
      expect(await repos.threads.findById(thread.id)).toMatchObject({ id: thread.id });
    });

    it("creates turns and supports find, list, latest, and status update", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });

      const userTurn = await repos.turns.create({
        threadId: thread.id,
        role: "user",
        status: "complete",
      });
      const assistantTurn = await repos.turns.create({
        threadId: thread.id,
        prevTurnId: userTurn.id,
        role: "assistant",
      });

      expect(await repos.turns.findById(assistantTurn.id)).toMatchObject({ id: assistantTurn.id });
      expect(await repos.turns.listByThread(thread.id)).toHaveLength(2);
      expect(await repos.turns.getLatestByThread(thread.id)).toMatchObject({
        id: assistantTurn.id,
      });

      const completed = await repos.turns.updateStatus(assistantTurn.id, {
        status: "complete",
        finishReason: "end_turn",
        completedAt: new Date().toISOString(),
      });
      expect(completed.status).toBe("complete");
      expect(completed.finishReason).toBe("end_turn");
    });

    it("honors caller-supplied turn id and createdAt", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });
      const createdAt = "2026-01-02T03:04:05.000Z";

      const turn = await repos.turns.create({
        id: "33333333-3333-4333-8333-333333333333",
        threadId: thread.id,
        createdAt,
        role: "assistant",
        status: "streaming",
      });

      expect(turn).toMatchObject({
        id: "33333333-3333-4333-8333-333333333333",
        createdAt,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: "0",
        responseCount: 0,
      });
      await expect(repos.turns.findById(turn.id)).resolves.toMatchObject({ id: turn.id });
    });

    it("does not clobber an existing turn when replaying the same turn id", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });
      const turnId = "33333333-3333-4333-8333-333333333333";

      const turn = await repos.turns.create({
        id: turnId,
        threadId: thread.id,
        createdAt: "2026-01-02T03:04:05.000Z",
        role: "assistant",
        status: "streaming",
      });
      await repos.modelResponses.create({
        id: "44444444-4444-4444-8444-444444444444",
        turnId: turn.id,
        sequence: 0,
        provider: "provider-a",
        model: "model-a",
        inputTokens: 10,
        outputTokens: 20,
        costUsd: "0.100000",
        priceSource: "provider_reported",
      });
      await repos.turns.recomputeRollups(turn.id);
      await repos.turns.updateStatus(turn.id, {
        status: "complete",
        finishReason: "end_turn",
        completedAt: "2026-01-02T03:04:06.000Z",
      });

      await repos.turns.create({
        id: turnId,
        threadId: thread.id,
        createdAt: "2026-01-02T03:04:07.000Z",
        role: "assistant",
        status: "pending",
      });

      expect(await repos.turns.findById(turn.id)).toMatchObject({
        id: turn.id,
        createdAt: "2026-01-02T03:04:05.000Z",
        status: "complete",
        finishReason: "end_turn",
        inputTokens: 10,
        outputTokens: 20,
        totalCostUsd: "0.100000",
        responseCount: 1,
      });
    });

    it("creates blocks with per-turn and per-thread ordering", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });
      const userTurn = await repos.turns.create({ threadId: thread.id, role: "user" });
      const assistantTurn = await repos.turns.create({
        threadId: thread.id,
        prevTurnId: userTurn.id,
        role: "assistant",
      });

      const userBlock = await repos.blocks.create({
        turnId: userTurn.id,
        blockType: "text",
        sequence: 0,
        textContent: "hello",
      });
      const assistantBlock = await repos.blocks.create({
        turnId: assistantTurn.id,
        blockType: "text",
        sequence: 0,
        textContent: "hi",
      });
      const modelResponse = await repos.modelResponses.create({
        turnId: assistantTurn.id,
        sequence: 0,
        provider: "test",
        model: "test-model",
        priceSource: "unknown",
      });
      const responseId = modelResponse.row.id;
      const blockWithResponse = await repos.blocks.create({
        turnId: assistantTurn.id,
        blockType: "text",
        sequence: 1,
        textContent: "linked",
        responseId,
      });

      expect(await repos.blocks.findById(userBlock.id)).toMatchObject({ id: userBlock.id });
      expect(await repos.blocks.findById(blockWithResponse.id)).toMatchObject({ responseId });
      expect((await repos.blocks.listByTurn(userTurn.id)).map((block) => block.id)).toEqual([
        userBlock.id,
      ]);
      expect((await repos.blocks.listByThread(thread.id)).map((block) => block.id)).toEqual([
        userBlock.id,
        assistantBlock.id,
        blockWithResponse.id,
      ]);
      expect(
        (await repos.blocks.listByTurn(assistantTurn.id)).find(
          (block) => block.id === blockWithResponse.id,
        )?.responseId,
      ).toBe(responseId);

      const pruned = await repos.blocks.updatePruned(assistantBlock.id, true);
      expect(pruned.pruned).toBe(true);
    });

    it("creates model responses and lists them by turn", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });
      const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });

      const modelResponse = await repos.modelResponses.create({
        turnId: turn.id,
        sequence: 0,
        provider: "test-provider",
        model: "test-model",
        inputTokens: 10,
        outputTokens: 20,
        costUsd: "0.010000",
        priceSource: "provider_reported",
      });

      expect(modelResponse.inserted).toBe(true);
      expect(await repos.modelResponses.findById(modelResponse.row.id)).toMatchObject({
        id: modelResponse.row.id,
        sequence: 0,
      });
      expect(await repos.modelResponses.listByTurn(turn.id)).toEqual([modelResponse.row]);
    });

    it("returns the existing model response when replaying the same response id", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });
      const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });
      const responseId = "55555555-5555-4555-8555-555555555555";

      const first = await repos.modelResponses.create({
        id: responseId,
        turnId: turn.id,
        sequence: 0,
        provider: "test-provider",
        model: "test-model",
        inputTokens: 10,
        outputTokens: 20,
        costUsd: "0.010000",
        priceSource: "provider_reported",
      });
      const replayed = await repos.modelResponses.create({
        id: responseId,
        turnId: turn.id,
        sequence: 0,
        provider: "other-provider",
        model: "other-model",
        inputTokens: 999,
        outputTokens: 999,
        costUsd: "9.990000",
        priceSource: "provider_reported",
      });

      expect(first.inserted).toBe(true);
      expect(replayed.inserted).toBe(false);
      expect(replayed.row).toEqual(first.row);
      expect(await repos.modelResponses.listByTurn(turn.id)).toEqual([first.row]);
    });

    it("recordModelResponseUsage persists response, turn rollups, and thread cost", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });
      const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });

      const { modelResponse, turn: updatedTurn } = await repos.recordModelResponseUsage({
        response: {
          turnId: turn.id,
          sequence: 0,
          provider: "provider-a",
          model: "model-a",
          inputTokens: 10,
          outputTokens: 20,
          reasoningTokens: 3,
          cacheReadTokens: 4,
          cacheWriteTokens: 5,
          costUsd: "0.100000",
          priceSource: "provider_reported",
        },
      });

      expect(updatedTurn).toMatchObject({
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 5,
        totalCostUsd: "0.100000",
        responseCount: 1,
        model: "model-a",
        provider: "provider-a",
      });
      expect(updatedTurn.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 20,
        totalCostUsd: "0.100000",
        responseCount: 1,
      });

      const persistedTurn = await repos.turns.findById(turn.id);
      expect(persistedTurn).toEqual(updatedTurn);
      expect(await repos.modelResponses.listByTurn(turn.id)).toEqual([modelResponse]);
      expect(await repos.modelResponses.findById(modelResponse.id)).toEqual(modelResponse);
      expect(await repos.threads.findById(thread.id)).toMatchObject({
        totalCostUsd: "0.100000",
      });
    });

    it("recordModelResponseUsage accumulates on a second call", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });
      const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });

      await repos.recordModelResponseUsage({
        response: {
          turnId: turn.id,
          sequence: 0,
          provider: "provider-a",
          model: "model-a",
          inputTokens: 10,
          outputTokens: 20,
          costUsd: "0.100000",
          priceSource: "provider_reported",
        },
      });

      const { turn: updatedTurn } = await repos.recordModelResponseUsage({
        response: {
          turnId: turn.id,
          sequence: 1,
          provider: "provider-a",
          model: "model-a",
          inputTokens: 1,
          outputTokens: 2,
          costUsd: "0.020000",
          priceSource: "provider_reported",
        },
      });

      expect(updatedTurn).toMatchObject({
        inputTokens: 11,
        outputTokens: 22,
        totalCostUsd: "0.120000",
        responseCount: 2,
      });
      expect(await repos.modelResponses.listByTurn(turn.id)).toHaveLength(2);
      expect(await repos.threads.findById(thread.id)).toMatchObject({
        totalCostUsd: "0.120000",
      });
    });

    it("recomputes turn rollups and thread cost from model response rows", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
      });
      const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });

      await repos.modelResponses.create({
        turnId: turn.id,
        sequence: 0,
        provider: "provider-a",
        model: "model-a",
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 5,
        costUsd: "0.100000",
        priceSource: "provider_reported",
      });
      await repos.modelResponses.create({
        turnId: turn.id,
        sequence: 1,
        provider: "provider-b",
        model: "model-b",
        inputTokens: 1,
        outputTokens: 2,
        costUsd: "0.020000",
        priceSource: "provider_reported",
      });
      const updatedTurn = await repos.turns.recomputeRollups(turn.id);

      expect(updatedTurn).toMatchObject({
        inputTokens: 11,
        outputTokens: 22,
        reasoningTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 5,
        totalCostUsd: "0.120000",
        responseCount: 2,
        model: "model-b",
        provider: "provider-b",
      });

      const recomputedAgain = await repos.turns.recomputeRollups(turn.id);
      expect(recomputedAgain).toMatchObject({
        inputTokens: 11,
        outputTokens: 22,
        totalCostUsd: "0.120000",
        responseCount: 2,
      });

      await repos.threads.recomputeCostFromModelResponses(thread.id);
      await repos.threads.recomputeCostFromModelResponses(thread.id);
      await repos.threads.updateCost(thread.id, "0", 1);
      expect(await repos.threads.findById(thread.id)).toMatchObject({
        totalCostUsd: "0.120000",
        turnCount: 1,
      });
    });

    it("updateCurrentAgent rebinds only while un-baked and turnCount is zero", async () => {
      const { repos, projects } = await makeFixture();
      const project = await projects.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Project",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
        currentAgent: "agent-a",
      });

      const rebound = await repos.threads.updateCurrentAgent(thread.id, "agent-b");
      expect(rebound).toMatchObject({ currentAgent: "agent-b" });

      const rawPromptThread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
        currentAgent: "agent-with-prompt-a",
        systemPrompt: "Raw pre-bake prompt",
      });
      const rawPromptRebound = await repos.threads.updateCurrentAgent(
        rawPromptThread.id,
        "agent-with-prompt-b",
      );
      expect(rawPromptRebound).toMatchObject({
        currentAgent: "agent-with-prompt-b",
        systemPrompt: "Raw pre-bake prompt",
        composedSystemPrompt: null,
      });

      const staleBake = await repos.threads.bakeComposedSystemPrompt(thread.id, {
        composedSystemPrompt: "stale",
        bakedSkillSlugs: ["stale-skill"],
        expectedCurrentAgent: "agent-a",
      });
      expect(staleBake).toMatchObject({
        currentAgent: "agent-b",
        composedSystemPrompt: null,
        bakedSkillSlugs: null,
      });

      await repos.threads.bakeComposedSystemPrompt(thread.id, {
        composedSystemPrompt: "frozen",
        bakedSkillSlugs: [],
        expectedCurrentAgent: "agent-b",
      });
      expect(await repos.threads.updateCurrentAgent(thread.id, "agent-c")).toBeNull();

      const started = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        projectId: project.id,
        currentAgent: "agent-d",
      });
      await repos.threads.updateCost(started.id, "0", 1);
      expect(await repos.threads.updateCurrentAgent(started.id, "agent-e")).toBeNull();
    });
  });
}
