import { describe, expect, it } from "vitest";
import { createInMemoryPackageStore } from "../domains/packages/index.js";
import { createInMemoryProjectRepository } from "../domains/projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../domains/threads/index.js";
import { forkThreadAgent, handoffThreadAgent } from "./thread-agent-swap.js";

async function setup() {
  const projects = createInMemoryProjectRepository();
  const project = await projects.create({ userId: "user-1", title: "Project" });
  const repos = createInMemoryRepositories({ projects });
  const packageRepository = createInMemoryPackageStore({
    agents: [
      {
        id: "agent-muse",
        projectId: project.id,
        slug: "muse",
        body: "Muse",
        meta: { mode: "primary" },
        config: {},
        packageInstallId: null,
        originalContentChecksum: null,
        sourceType: "builtin",
        enabled: true,
      },
    ],
  });
  const eventWriter = createInMemoryEventJournalWriter();
  const source = await repos.threads.create({
    userId: "user-1",
    projectId: project.id,
    workId: "work-1",
    currentAgent: "writer",
    title: "Chapter chat",
  });
  const userTurn = await repos.turns.create({
    threadId: source.id,
    role: "user",
    status: "complete",
  });
  await repos.blocks.create({
    turnId: userTurn.id,
    blockType: "text",
    sequence: 0,
    textContent: "I need a better duel scene.",
    content: { text: "I need a better duel scene." },
  });
  await repos.threadDocuments.attach(source.id, "document-editing", "editing");
  await repos.threadDocuments.attach(source.id, "document-reading", "reading");
  return { repos, projects, packageRepository, eventWriter, source, userTurn };
}

describe("thread agent swap", () => {
  it("handoff creates a new primary thread with a summary system turn", async () => {
    const env = await setup();

    const target = await handoffThreadAgent(
      {
        threads: env.repos.threads,
        turns: env.repos.turns,
        blocks: env.repos.blocks,
        threadDocuments: env.repos.threadDocuments,
        projects: env.projects,
        packageRepository: env.packageRepository,
        eventWriter: env.eventWriter,
      },
      {
        threadId: env.source.id,
        userId: "user-1",
        targetAgent: "muse",
        summary: "Duel needs stakes.",
      },
    );

    expect(target).toMatchObject({
      kind: "primary",
      parentThreadId: env.source.id,
      currentAgent: "muse",
    });
    const turns = await env.repos.turns.listByThread(target.id);
    expect(turns[0]).toMatchObject({ role: "system", status: "complete" });
    const systemTurn = turns[0];
    expect(systemTurn).toBeDefined();
    const blocks = await env.repos.blocks.listByTurn(systemTurn?.id ?? "missing");
    expect(blocks[0]?.textContent).toContain("Duel needs stakes.");
    expect(await env.repos.threadDocuments.listByThread(target.id)).toMatchObject([
      { documentId: "document-editing", relationship: "editing" },
    ]);
    expect(await env.eventWriter.listByType(env.source.id, "agent.handoff")).toHaveLength(1);
  });

  it("fork creates a new primary thread from the requested origin turn", async () => {
    const env = await setup();

    const target = await forkThreadAgent(
      {
        threads: env.repos.threads,
        turns: env.repos.turns,
        blocks: env.repos.blocks,
        threadDocuments: env.repos.threadDocuments,
        projects: env.projects,
        packageRepository: env.packageRepository,
        eventWriter: env.eventWriter,
      },
      {
        threadId: env.source.id,
        userId: "user-1",
        targetAgent: "muse",
        originTurnId: env.userTurn.id,
      },
    );

    expect(target).toMatchObject({
      kind: "primary",
      parentThreadId: env.source.id,
      currentAgent: "muse",
    });
    const forkEvents = await env.eventWriter.listByType(env.source.id, "agent.fork");
    expect(forkEvents[0]?.payload).toMatchObject({
      originTurnId: env.userTurn.id,
      targetThreadId: target.id,
    });
    expect(await env.repos.threadDocuments.listByThread(target.id)).toMatchObject([
      { documentId: "document-editing", relationship: "editing" },
    ]);
  });
  it("rejects fork origins that do not belong to the source thread", async () => {
    const env = await setup();
    const other = await env.repos.threads.create({
      userId: "user-1",
      projectId: env.source.projectId,
      workId: "work-1",
    });
    const foreignTurn = await env.repos.turns.create({
      threadId: other.id,
      role: "user",
      status: "complete",
    });

    await expect(
      forkThreadAgent(
        {
          threads: env.repos.threads,
          turns: env.repos.turns,
          blocks: env.repos.blocks,
          threadDocuments: env.repos.threadDocuments,
          projects: env.projects,
          packageRepository: env.packageRepository,
          eventWriter: env.eventWriter,
        },
        {
          threadId: env.source.id,
          userId: "user-1",
          targetAgent: "muse",
          originTurnId: foreignTurn.id,
        },
      ),
    ).rejects.toThrow("Fork origin turn must belong to the source thread");
  });
});
