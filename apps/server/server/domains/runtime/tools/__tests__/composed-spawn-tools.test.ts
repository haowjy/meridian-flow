import { describe, expect, it } from "vitest";
import { createTestAgentBinding } from "../../loop/__tests__/test-orchestrator-deps.js";
import { resolveAgentThreadTurnContext } from "../agent-thread-context.js";
import {
  createCoreToolRegistrations,
  createSpawnToolRegistrations,
  createToolRegistry,
} from "../index.js";

const coreHandler = async () => ({ ok: true });

describe("resolveAgentThreadTurnContext spawn tools", () => {
  it("advertises a bound child report tool exactly once", async () => {
    const registry = createToolRegistry({
      registrations: [
        ...createCoreToolRegistrations({
          work: coreHandler,
          write: coreHandler,
          ls: coreHandler,
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
        kind: "subagent",
        status: "idle",
        title: null,
        ref: null,
        composedSystemPrompt: null,
        bakedSkillSlugs: null,
        systemPrompt: null,
        workingState: null,
        currentAgent: "muse",
        agentDefinitionRevisionId: null,
        agentName: null,
        activeLeafTurnId: null,
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
      agentRevisions: createTestAgentBinding("fixture-model", "", () => ["thread-1"]),
      toolRegistry: registry,
      baseTools: registry.getDefinitions(),
    });

    const names =
      context.tools?.map((tool) => (tool.type === "function" ? tool.name : tool.kind)) ?? [];
    expect(names.filter((name) => name === "spawn")).toHaveLength(0);
    expect(names.filter((name) => name === "return_result")).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });
});
