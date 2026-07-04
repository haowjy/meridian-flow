import { describe, expect, it } from "vitest";
import { createInMemoryPackageStore } from "../../../packages/index.js";
import { resolveAgentThreadTurnContext } from "../agent-thread-context.js";
import {
  createCoreToolRegistrations,
  createSpawnToolRegistrations,
  createToolRegistry,
} from "../index.js";

const coreHandler = async () => ({ ok: true });

describe("resolveAgentThreadTurnContext spawn tools", () => {
  it("advertises spawn exactly once for Muse when base tools include core handlers only", async () => {
    const packageRepository = createInMemoryPackageStore({
      agents: [
        {
          id: "agent-muse",
          projectId: "project-1",
          slug: "muse",
          body: "Muse",
          meta: { subagents: ["writer-helper"] },
          config: {},
          packageInstallId: null,
          originalContentChecksum: null,
          sourceType: "builtin",
          enabled: true,
        },
      ],
    });
    const registry = createToolRegistry({
      registrations: [
        ...createCoreToolRegistrations({
          write: coreHandler,
          list: coreHandler,
          search: coreHandler,
          ask_user: coreHandler,
        }),
        ...createSpawnToolRegistrations(),
      ],
    });

    const context = await resolveAgentThreadTurnContext({
      thread: {
        id: "thread-1",
        projectId: "project-1",
        workId: null,
        userId: "user-1",
        kind: "primary",
        status: "idle",
        title: null,
        composedSystemPrompt: null,
        bakedSkillSlugs: null,
        systemPrompt: null,
        workingState: null,
        currentAgent: "muse",
        parentThreadId: null,
        rootThreadId: "thread-1",
        spawnDepth: 0,
        spawnStatus: null,
        totalCostUsd: "0",
        turnCount: 0,
        createdAt: "2026-06-12T00:00:00.000Z",
        updatedAt: "2026-06-12T00:00:00.000Z",
        deletedAt: null,
      },
      packageRepository,
      toolRegistry: registry,
      baseTools: registry.getDefinitions(),
    });

    const names =
      context.tools?.map((tool) => (tool.type === "function" ? tool.name : tool.kind)) ?? [];
    expect(names.filter((name) => name === "spawn")).toHaveLength(1);
    expect(names.filter((name) => name === "return_result")).toHaveLength(0);
    expect(new Set(names).size).toBe(names.length);
  });
});
