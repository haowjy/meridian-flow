import { createObservationAuthority, type ObservationSnapshot } from "@meridian/agent-edit";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
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
    activeLeafTurnId: null,
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
  it("reconstructs request evidence after restart and drops it when the result is pruned", async () => {
    const stored = new Map<string, ObservationSnapshot>();
    const authority = createObservationAuthority({
      store: {
        async seal(snapshot) {
          stored.set(snapshot.responseId, snapshot);
        },
        async load(responseId) {
          return stored.get(responseId) ?? null;
        },
      },
    });
    const assistantTurn = {
      id: "turn-1",
      role: "assistant",
    } as Turn;
    const toolResult = {
      id: "block-1",
      turnId: assistantTurn.id,
      blockType: "tool_result",
      sequence: 0,
      pruned: false,
      responseId: "response-read",
      createdAt,
      content: {
        toolCallId: "call-read",
        output: "abcd|Writer body.",
        metadata: {
          documentId: "doc-1",
          observationEvidence: [
            {
              kind: "rendered",
              clientID: 7,
              clock: 11,
              renderedContent: "paragraph|Writer body.",
              sourceText: "abcd|Writer body.",
            },
          ],
        },
      },
    } as unknown as Block;
    const assemble = (block: Block, requestId: string) =>
      assembleNextTurnContext({
        thread: thread({ composedSystemPrompt: "Frozen", bakedSkillSlugs: [] }),
        turns: [assistantTurn],
        blocks: [block],
        packageRepository: packageRepository() as never,
        toolRegistry: { getRegistration: () => undefined } as never,
        observationAuthority: authority,
        requestId,
        responseCausalCuts: [
          {
            id: `cut-${requestId}`,
            version: 1,
            documentId: "doc-1",
            authorityId: "doc-1",
            generation: 1n,
            admittedThrough: 0n,
          },
        ],
      });

    const beforeRestart = await assemble(toolResult, "request-before-restart");
    if (!beforeRestart.observationCandidate) throw new Error("missing observation candidate");
    await authority.sealSuccessfulResponse(
      "response-before-restart",
      beforeRestart.observationCandidate,
    );
    const afterRestart = await assemble(structuredClone(toolResult), "request-after-restart");
    if (!afterRestart.observationCandidate) throw new Error("missing observation candidate");
    await authority.sealSuccessfulResponse(
      "response-after-restart",
      afterRestart.observationCandidate,
    );
    const afterPrune = await assemble({ ...toolResult, pruned: true }, "request-after-prune");
    if (!afterPrune.observationCandidate) throw new Error("missing observation candidate");
    await authority.sealSuccessfulResponse("response-after-prune", afterPrune.observationCandidate);

    expect(stored.get("response-after-restart")?.entries).toEqual(
      stored.get("response-before-restart")?.entries,
    );
    expect(stored.get("response-after-prune")?.entries).toEqual([]);
    expect(JSON.stringify(afterPrune.generateRequest.messages)).not.toContain("Writer body.");
  });

  it("rebuilds context when a losing bake observes another agent's frozen row", async () => {
    const frozenByAgentB = thread({
      currentAgent: "agent-b",
      composedSystemPrompt:
        "Prompt for agent-b\n\nContext file URI rules: bare file paths resolve as `manuscript://` -- the writer's manuscript documents. `kb://` is the project knowledge base (durable reference: characters, places, canon). `scratch://` holds working files for this work item -- plans, notes, intermediate material; never the manuscript. It belongs to this work item only: switch work items and you are in a different scratch space. Anything meant to outlive this work item belongs in `kb://` or the manuscript. `uploads://` holds files the writer attached to this work item (same scoping). `user://` is the writer's personal files. Use `write` with command=create/read/insert/replace/undo/redo for document content; use `ls` and `grep` for discovery.",
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
