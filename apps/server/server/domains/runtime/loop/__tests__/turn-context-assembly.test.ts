import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { assembleNextTurnContext } from "../turn-context-assembly.js";

const createdAt = "2026-06-07T00:00:00.000Z";

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
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
    currentAgent: "agent-a",
    parentThreadId: null,
    rootThreadId: "thread-1",
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

function packageRepository() {
  return {
    async getAgentWithLinkedSkills(_projectId: string, _userId: string, agentSlug: string) {
      return {
        agent: {
          id: `${agentSlug}-id`,
          projectId: "project-1",
          slug: agentSlug,
          body: `Prompt for ${agentSlug}`,
          meta: { model: `model-${agentSlug}` },
          config: {},
          packageInstallId: null,
          originalContentChecksum: null,
          sourceType: "user",
          enabled: true,
        },
        skills: [],
      };
    },
  };
}

describe("assembleNextTurnContext", () => {
  it("rebuilds context when a losing bake observes another agent's frozen row", async () => {
    const frozenByAgentB = thread({
      currentAgent: "agent-b",
      composedSystemPrompt:
        "Prompt for agent-b\n\nRuntime URI rules: use kb://, user://, work://, or fs1:// URIs exactly as provided by context tools.",
      bakedSkillSlugs: [],
      systemPrompt: null,
    });
    const bakeAttempts: string[] = [];

    const assembled = await assembleNextTurnContext({
      thread: thread({ currentAgent: "agent-a" }),
      turns: [],
      blocks: [],
      packageRepository: packageRepository() as never,
      toolRegistry: { getRegistration: () => undefined } as never,
      persistBake: true,
      async bakeComposedSystemPrompt(_threadId, input) {
        bakeAttempts.push(input.expectedCurrentAgent ?? "none");
        if (input.expectedCurrentAgent === "agent-a") {
          return frozenByAgentB;
        }
        return thread({
          currentAgent: "agent-b",
          composedSystemPrompt: input.composedSystemPrompt,
          bakedSkillSlugs: input.bakedSkillSlugs,
          systemPrompt: null,
        });
      },
    });

    expect(bakeAttempts).toEqual(["agent-a"]);
    expect(assembled.agentSlug).toBe("agent-b");
    expect(assembled.generateRequest.model).toBe("model-agent-b");
    expect(assembled.systemPrompt).toContain("Prompt for agent-b");
    expect(assembled.systemPrompt).not.toContain("Prompt for agent-a");
  });

  it("retries the bake when an agent rebind wins before the prompt is frozen", async () => {
    const bakeAttempts: string[] = [];

    const assembled = await assembleNextTurnContext({
      thread: thread({ currentAgent: "agent-a" }),
      turns: [],
      blocks: [],
      packageRepository: packageRepository() as never,
      toolRegistry: { getRegistration: () => undefined } as never,
      persistBake: true,
      async bakeComposedSystemPrompt(_threadId, input) {
        bakeAttempts.push(input.expectedCurrentAgent ?? "none");
        if (input.expectedCurrentAgent === "agent-a") {
          return thread({ currentAgent: "agent-b" });
        }
        return thread({
          currentAgent: "agent-b",
          composedSystemPrompt: input.composedSystemPrompt,
          bakedSkillSlugs: input.bakedSkillSlugs,
          systemPrompt: null,
        });
      },
    });

    expect(bakeAttempts).toEqual(["agent-a", "agent-b"]);
    expect(assembled.agentSlug).toBe("agent-b");
    expect(assembled.generateRequest.model).toBe("model-agent-b");
    expect(assembled.systemPrompt).toContain("Prompt for agent-b");
    expect(assembled.systemPrompt).not.toContain("Prompt for agent-a");
  });
});
