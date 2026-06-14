import { describe, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import { createInMemoryRepositories } from "../../../threads/index.js";
import { buildContext } from "../context-builder.js";
import { loadThreadConversationContext } from "../fork-thread-context.js";

describe("loadThreadConversationContext", () => {
  it("hydrates forked runtime context through originTurnId and excludes later parent turns", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Project" });
    const repos = createInMemoryRepositories({ projects });

    const parent = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      workId: "work-1",
      currentAgent: "writer",
    });
    const firstUser = await repos.turns.create({
      threadId: parent.id,
      role: "user",
      status: "complete",
    });
    await repos.blocks.create({
      turnId: firstUser.id,
      blockType: "text",
      sequence: 0,
      textContent: "Before fork.",
      content: { text: "Before fork." },
    });
    const firstAssistant = await repos.turns.create({
      threadId: parent.id,
      role: "assistant",
      status: "complete",
      prevTurnId: firstUser.id,
    });
    await repos.blocks.create({
      turnId: firstAssistant.id,
      blockType: "text",
      sequence: 0,
      textContent: "Draft A.",
      content: { text: "Draft A." },
    });
    const afterForkUser = await repos.turns.create({
      threadId: parent.id,
      role: "user",
      status: "complete",
      prevTurnId: firstAssistant.id,
    });
    await repos.blocks.create({
      turnId: afterForkUser.id,
      blockType: "text",
      sequence: 0,
      textContent: "After fork on parent.",
      content: { text: "After fork on parent." },
    });

    const fork = await repos.threads.createDerivedPrimary({
      userId: "user-1",
      projectId: project.id,
      workId: "work-1",
      parentThreadId: parent.id,
      originType: "fork",
      originTurnId: firstAssistant.id,
      currentAgent: "muse",
      title: "Fork",
    });
    const forkSystem = await repos.turns.create({
      threadId: fork.id,
      role: "system",
      status: "complete",
    });
    await repos.blocks.create({
      turnId: forkSystem.id,
      blockType: "text",
      sequence: 0,
      textContent: "Forked conversation through turn.",
      content: { text: "Forked conversation through turn." },
    });

    const conversation = await loadThreadConversationContext(
      { threads: repos.threads, turns: repos.turns, blocks: repos.blocks },
      fork,
    );
    const { messages } = buildContext({
      thread: { ...fork, composedSystemPrompt: "Muse prompt", bakedSkillSlugs: [] },
      turns: conversation.turns,
      blocks: conversation.blocks,
    });

    const transcript = messages
      .flatMap((message) =>
        message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )
      .join("\n");

    expect(transcript).toContain("Before fork.");
    expect(transcript).toContain("Draft A.");
    expect(transcript).not.toContain("After fork on parent.");
    expect(transcript).toContain("Forked conversation through turn.");
  });

  it("hydrates forks of forks through the full inherited lineage", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Project" });
    const repos = createInMemoryRepositories({ projects });
    const root = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      workId: "work-1",
    });
    const rootTurn = await repos.turns.create({
      threadId: root.id,
      role: "user",
      status: "complete",
    });
    await repos.blocks.create({
      turnId: rootTurn.id,
      blockType: "text",
      sequence: 0,
      textContent: "Root memory.",
      content: { text: "Root memory." },
    });
    const firstFork = await repos.threads.createDerivedPrimary({
      userId: "user-1",
      projectId: project.id,
      workId: "work-1",
      parentThreadId: root.id,
      originType: "fork",
      originTurnId: rootTurn.id,
      currentAgent: null,
      title: "Fork 1",
    });
    const forkTurn = await repos.turns.create({
      threadId: firstFork.id,
      role: "assistant",
      status: "complete",
    });
    await repos.blocks.create({
      turnId: forkTurn.id,
      blockType: "text",
      sequence: 0,
      textContent: "Fork memory.",
      content: { text: "Fork memory." },
    });
    const secondFork = await repos.threads.createDerivedPrimary({
      userId: "user-1",
      projectId: project.id,
      workId: "work-1",
      parentThreadId: firstFork.id,
      originType: "fork",
      originTurnId: forkTurn.id,
      currentAgent: null,
      title: "Fork 2",
    });

    const conversation = await loadThreadConversationContext(
      { threads: repos.threads, turns: repos.turns, blocks: repos.blocks },
      secondFork,
    );
    const blockText = conversation.blocks.map((block) => block.textContent).join("\n");
    expect(blockText).toContain("Root memory.");
    expect(blockText).toContain("Fork memory.");
  });
});
