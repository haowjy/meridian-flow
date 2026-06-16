import { describe, expect, it } from "vitest";
import type { AgentDefinitionRecord } from "../domains/packages/domain/types.js";
import { createInMemoryPackageStore } from "../domains/packages/index.js";
import { createInMemoryProjectRepository } from "../domains/projects/index.js";
import { createInMemoryRepositories } from "../domains/threads/index.js";
import { rebindThreadAgent, ThreadAlreadyStartedError } from "./thread-agent-rebind.js";
import { AgentBindingNotFoundError } from "./thread-creation.js";

function packageStoreWithAgents(projectId: string, agents: AgentDefinitionRecord[]) {
  return createInMemoryPackageStore({
    agents: agents.map((agent) => ({ ...agent, projectId })),
  });
}

describe("rebindThreadAgent", () => {
  it("rebinds currentAgent on a blank thread", async () => {
    const projects = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects });
    const project = await projects.create({ userId: "user-1", title: "WB" });
    const packageRepository = packageStoreWithAgents(project.id, [
      {
        id: "agent-a",
        projectId: project.id,
        slug: "agent-a",
        body: "A",
        meta: {},
        config: {},
        packageInstallId: "pkg-1",
        originalContentChecksum: null,
        sourceType: "package",
        enabled: true,
      },
      {
        id: "agent-b",
        projectId: project.id,
        slug: "agent-b",
        body: "B",
        meta: {},
        config: {},
        packageInstallId: "pkg-1",
        originalContentChecksum: null,
        sourceType: "package",
        enabled: true,
      },
    ]);

    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      currentAgent: "agent-a",
    });

    const updated = await rebindThreadAgent(
      { threads: repos.threads, projects, packageRepository },
      { threadId: thread.id, userId: "user-1", currentAgent: "agent-b" },
    );

    expect(updated.currentAgent).toBe("agent-b");
  });

  it("rejects unknown agent slugs", async () => {
    const projects = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects });
    const packageRepository = packageStoreWithAgents("wb", []);
    const project = await projects.create({ userId: "user-1", title: "WB" });
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
    });

    await expect(
      rebindThreadAgent(
        { threads: repos.threads, projects, packageRepository },
        { threadId: thread.id, userId: "user-1", currentAgent: "missing" },
      ),
    ).rejects.toBeInstanceOf(AgentBindingNotFoundError);
  });

  it("returns 409-equivalent when the thread is already baked", async () => {
    const projects = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects });
    const project = await projects.create({ userId: "user-1", title: "WB" });
    const packageRepository = packageStoreWithAgents(project.id, [
      {
        id: "agent-b",
        projectId: project.id,
        slug: "agent-b",
        body: "B",
        meta: {},
        config: {},
        packageInstallId: "pkg-1",
        originalContentChecksum: null,
        sourceType: "package",
        enabled: true,
      },
    ]);
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      currentAgent: "agent-a",
    });
    await repos.threads.bakeComposedSystemPrompt(thread.id, {
      expectedCurrentAgent: "agent-a",
      composedSystemPrompt: "baked",
      bakedSkillSlugs: [],
    });

    await expect(
      rebindThreadAgent(
        { threads: repos.threads, projects, packageRepository },
        { threadId: thread.id, userId: "user-1", currentAgent: "agent-b" },
      ),
    ).rejects.toBeInstanceOf(ThreadAlreadyStartedError);
  });

  it("hides threads from other users", async () => {
    const projects = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects });
    const packageRepository = packageStoreWithAgents("wb", []);
    const project = await projects.create({ userId: "user-1", title: "WB" });
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
    });

    await expect(
      rebindThreadAgent(
        { threads: repos.threads, projects, packageRepository },
        { threadId: thread.id, userId: "user-2", currentAgent: null },
      ),
    ).rejects.toThrow(/Thread not found/);
  });
});
