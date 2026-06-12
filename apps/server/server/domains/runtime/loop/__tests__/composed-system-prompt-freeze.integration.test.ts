/**
 * Composed system prompt freeze: bake once on first attempt, byte-identical reuse,
 * subagent pre-bake protection, and bake-only-once persistence.
 */
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import type {
  AgentDefinitionRecord,
  AgentSkillLinkRecord,
  SkillRecord,
} from "../../../packages/domain/types.js";
import { createInMemoryPackageStore } from "../../../packages/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  type InternalThreadRepositories,
} from "../../../threads/index.js";
import { createInMemoryWorkbenchRepository } from "../../../workbenches/index.js";
import type { Gateway, GenerateRequest, GenerateResult, StreamEvent } from "../../gateway/index.js";
import {
  createCoreToolRegistrations,
  createInvokeToolRegistration,
  createToolExecutor,
  createToolRegistry,
  type ToolRegistry,
} from "../../tools/index.js";
import {
  modelInvocableSkillSlugs,
  renderSkillsSystemPromptSection,
  SKILLS_CATALOG_PROMPT_MARKER,
} from "../../tools/skill-tools.js";
import {
  assembleComposedSystemPrompt,
  bakedSkillSetAdvertisesInvoke,
} from "../composed-system-prompt.js";
import { RUNTIME_URI_SYSTEM_INSTRUCTION } from "../context-builder.js";
import { createOrchestrator } from "../orchestrator.js";
import { assembleNextTurnContext } from "../turn-context-assembly.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

const coreHandler = async () => ({ ok: true });
const coreRegistrations = createCoreToolRegistrations({
  read: coreHandler,
  edit: coreHandler,
  write: coreHandler,
  list: coreHandler,
  search: coreHandler,
  ask_user: coreHandler,
});

function gatewayCapturingRequests(results: GenerateResult[]) {
  let index = 0;
  const systemTexts: string[] = [];
  const toolNames: string[][] = [];
  const gateway: Gateway = {
    async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
      const systemMessage = request.messages.find((message) => message.role === "system");
      const text =
        systemMessage?.content
          .map((part) => ("text" in part ? part.text : ""))
          .filter(Boolean)
          .join("\n") ?? "";
      systemTexts.push(text);
      toolNames.push(
        (request.tools ?? []).map((tool) => (tool.type === "function" ? tool.name : tool.kind)),
      );
      const result = results[index++];
      if (!result) throw new Error(`No stubbed result for model call ${index}`);
      yield { type: "end", result };
    },
    async generate() {
      throw new Error("not used");
    },
  };
  return { gateway, systemTexts, toolNames };
}

function endTurnResult(): GenerateResult {
  return {
    content: [{ type: "text", text: "done" }],
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "stub-model",
    provider: "stub",
  };
}

function skillRecord(workbenchId: string, slug: string): SkillRecord {
  return {
    id: `skill-${slug}`,
    workbenchId,
    slug,
    body: "# Skill",
    meta: {
      description: `Run ${slug}`,
    },
    files: {},
    packageInstallId: "pkg-1",
    originalContentChecksum: null,
    sourceType: "package",
    enabled: true,
  };
}

function seedPackageWithoutInvoke(workbenchId: string, skills: SkillRecord[]) {
  const agent: AgentDefinitionRecord = {
    id: "agent-1",
    workbenchId,
    slug: "agent-one",
    body: "Agent body.",
    meta: { model: "claude-sonnet-4-20250514" },
    config: {},
    packageInstallId: "pkg-1",
    originalContentChecksum: null,
    sourceType: "package",
    enabled: true,
  };
  const agentSkills: AgentSkillLinkRecord[] = skills.map((skill) => ({
    agentDefinitionId: agent.id,
    skillId: skill.id,
    modelInvocable: false,
  }));
  return createInMemoryPackageStore({ agents: [agent], skills, agentSkills });
}

function seedPackage(workbenchId: string, skills: SkillRecord[], agentBody = "Agent body.") {
  const agent: AgentDefinitionRecord = {
    id: "agent-1",
    workbenchId,
    slug: "agent-one",
    body: agentBody,
    meta: { model: "claude-sonnet-4-20250514" },
    config: {},
    packageInstallId: "pkg-1",
    originalContentChecksum: null,
    sourceType: "package",
    enabled: true,
  };
  const agentSkills: AgentSkillLinkRecord[] = skills.map((skill, index) => ({
    agentDefinitionId: agent.id,
    skillId: skill.id,
    modelInvocable: index === 0,
  }));
  return createInMemoryPackageStore({ agents: [agent], skills, agentSkills });
}

function seedTwoAgentPackage(workbenchId: string) {
  const agentOne: AgentDefinitionRecord = {
    id: "agent-1",
    workbenchId,
    slug: "agent-one",
    body: "Agent A body.",
    meta: { model: "claude-sonnet-4-20250514" },
    config: {},
    packageInstallId: "pkg-1",
    originalContentChecksum: null,
    sourceType: "package",
    enabled: true,
  };
  const agentTwo: AgentDefinitionRecord = {
    id: "agent-2",
    workbenchId,
    slug: "agent-two",
    body: "Agent B body.",
    meta: { model: "claude-sonnet-4-20250514" },
    config: {},
    packageInstallId: "pkg-1",
    originalContentChecksum: null,
    sourceType: "package",
    enabled: true,
  };
  return createInMemoryPackageStore({ agents: [agentOne, agentTwo] });
}

function createInvokeRegistry(
  repos: InternalThreadRepositories,
  packageRepository: ReturnType<typeof createInMemoryPackageStore>,
): ToolRegistry {
  return createToolRegistry({
    registrations: [
      ...coreRegistrations,
      createInvokeToolRegistration({
        packageRepository,
        findThreadById: async (threadId) => {
          const thread = await repos.threads.findById(threadId);
          if (!thread) return null;
          return {
            workbenchId: thread.workbenchId,
            userId: thread.userId,
            currentAgent: thread.currentAgent,
            bakedSkillSlugs: thread.bakedSkillSlugs ?? null,
          };
        },
      }),
    ],
  });
}

async function setupOrchestrator(
  buildPackage: (workbenchId: string) => ReturnType<typeof createInMemoryPackageStore>,
) {
  const workbenchRepo = createInMemoryWorkbenchRepository();
  const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
  const workbench = await workbenchRepo.create({ userId: "user-1", title: "WB" });
  const packageRepository = buildPackage(workbench.id);
  const toolRegistry = createInvokeRegistry(repos, packageRepository);
  const creditLedger = createInMemoryCreditLedger();
  await creditLedger.grant({
    userId: "user-1",
    workbenchId: workbench.id,
    source: "manual",
    amountMillicredits: "1000000000",
    reason: "test",
  });
  const capture = gatewayCapturingRequests([endTurnResult(), endTurnResult()]);
  const orchestrator = createOrchestrator(
    createTestOrchestratorDeps({
      gateway: capture.gateway,
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      packageRepository,
      toolRegistry,
      toolExecutor: createToolExecutor(toolRegistry),
      creditLedger,
    }),
  );
  return { repos, orchestrator, workbench, ...capture, creditLedger };
}

describe("composed system prompt freeze", () => {
  it("keeps turn 2 system prompt byte-identical after a skill is installed between turns", async () => {
    let workbenchId = "";
    let initialSkill: SkillRecord | undefined;
    const { repos, orchestrator, workbench, systemTexts, toolNames, creditLedger } =
      await setupOrchestrator((id) => {
        workbenchId = id;
        initialSkill = skillRecord(id, "skill-one");
        return seedPackage(id, [initialSkill]);
      });
    if (!initialSkill) throw new Error("expected seeded skill");
    const thread = await repos.threads.create({
      userId: "user-1",
      workbenchId: workbench.id,
      currentAgent: "agent-one",
    });

    const first = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "turn one",
      treeBudget: createDefaultTreeBudget(),
    });
    for await (const _event of first.events) {
      // drain
    }

    const threadAfterTurnOne = await repos.threads.findById(thread.id);
    const bakedAfterTurnOne = threadAfterTurnOne?.composedSystemPrompt;
    expect(bakedAfterTurnOne).toBeTruthy();
    expect(threadAfterTurnOne?.bakedSkillSlugs).toEqual(["skill-one"]);
    expect(systemTexts[0]).toBe(bakedAfterTurnOne);
    expect(systemTexts[0]).toContain("skill-one");
    expect(toolNames[0]).toContain("invoke");

    const turnTwoCapture = gatewayCapturingRequests([endTurnResult()]);
    const packageAfterInstall = seedPackage(workbenchId, [
      initialSkill,
      skillRecord(workbenchId, "skill-two"),
    ]);
    const turnTwoRegistry = createInvokeRegistry(repos, packageAfterInstall);
    const turnTwoOrchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        gateway: turnTwoCapture.gateway,
        repos,
        eventWriter: createInMemoryEventJournalWriter(),
        packageRepository: packageAfterInstall,
        toolRegistry: turnTwoRegistry,
        toolExecutor: createToolExecutor(turnTwoRegistry),
        creditLedger,
      }),
    );

    const second = await turnTwoOrchestrator.runTurn({
      threadId: thread.id,
      userText: "turn two",
      treeBudget: createDefaultTreeBudget(),
    });
    for await (const _event of second.events) {
      // drain
    }

    expect(turnTwoCapture.systemTexts[0]).toBe(systemTexts[0]);
    expect(turnTwoCapture.systemTexts[0]).not.toContain("skill-two");
    expect(turnTwoCapture.toolNames[0]).toEqual(toolNames[0]);
    const threadAfterTurnTwo = await repos.threads.findById(thread.id);
    expect(threadAfterTurnTwo?.composedSystemPrompt).toBe(bakedAfterTurnOne);
    expect(threadAfterTurnTwo?.bakedSkillSlugs).toEqual(["skill-one"]);
  });

  it("does not overwrite a pre-frozen subagent composedSystemPrompt on first attempt", async () => {
    let packageRepository!: ReturnType<typeof createInMemoryPackageStore>;
    const { repos, orchestrator, workbench, systemTexts } = await setupOrchestrator((id) => {
      const skill = skillRecord(id, "skill-one");
      packageRepository = seedPackage(id, [skill], "Subagent body.");
      return packageRepository;
    });
    const resolved = await packageRepository.getAgentWithLinkedSkills(
      workbench.id,
      "user-1",
      "agent-one",
    );
    const frozenPrompt = assembleComposedSystemPrompt({
      basePrompt: "Subagent body.",
      skillsSystemPromptSection: renderSkillsSystemPromptSection(resolved.skills),
    });
    const thread = await repos.threads.createSubagent({
      userId: "user-1",
      workbenchId: workbench.id,
      parentThreadId: "parent-1",
      rootThreadId: "parent-1",
      spawnDepth: 1,
      currentAgent: "agent-one",
      composedSystemPrompt: frozenPrompt,
      bakedSkillSlugs: modelInvocableSkillSlugs(resolved.skills),
      title: "child",
      spawnStatus: "running",
    });

    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "hello",
      treeBudget: createDefaultTreeBudget(),
    });
    for await (const _event of handle.events) {
      // drain
    }

    expect(systemTexts[0]).toBe(frozenPrompt);
    expect((await repos.threads.findById(thread.id))?.composedSystemPrompt).toBe(frozenPrompt);
  });

  it("persists composedSystemPrompt only on the first turn", async () => {
    const { repos, orchestrator, workbench } = await setupOrchestrator((id) =>
      seedPackage(id, [skillRecord(id, "skill-one")]),
    );
    const thread = await repos.threads.create({
      userId: "user-1",
      workbenchId: workbench.id,
      currentAgent: "agent-one",
    });
    expect(thread.composedSystemPrompt).toBeNull();

    const updates: Array<{
      expectedCurrentAgent?: string | null;
      composedSystemPrompt: string;
      bakedSkillSlugs: string[];
    }> = [];
    const originalBake = repos.threads.bakeComposedSystemPrompt.bind(repos.threads);
    repos.threads.bakeComposedSystemPrompt = async (id, input) => {
      updates.push(input);
      return originalBake(id, input);
    };

    const first = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "one",
      treeBudget: createDefaultTreeBudget(),
    });
    for await (const _event of first.events) {
      // drain
    }
    expect(updates).toHaveLength(1);

    const second = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "two",
      treeBudget: createDefaultTreeBudget(),
    });
    for await (const _event of second.events) {
      // drain
    }
    expect(updates).toHaveLength(1);
    expect(updates[0]?.bakedSkillSlugs).toEqual(["skill-one"]);
  });

  it("does not advertise invoke when the baked skill set is empty", async () => {
    const { repos, orchestrator, workbench, toolNames } = await setupOrchestrator((id) =>
      seedPackageWithoutInvoke(id, [skillRecord(id, "skill-one")]),
    );
    const thread = await repos.threads.create({
      userId: "user-1",
      workbenchId: workbench.id,
      currentAgent: "agent-one",
    });
    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "hello",
      treeBudget: createDefaultTreeBudget(),
    });
    for await (const _event of handle.events) {
      // drain
    }
    expect((await repos.threads.findById(thread.id))?.bakedSkillSlugs).toEqual([]);
    expect(toolNames[0]).not.toContain("invoke");
  });

  it("compare-and-swap bake: exactly one concurrent write wins; loser uses winner prompt", async () => {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
    const workbench = await workbenchRepo.create({ userId: "user-1", title: "WB" });
    const thread = await repos.threads.create({
      userId: "user-1",
      workbenchId: workbench.id,
      currentAgent: "agent-one",
    });

    const [winner, loser] = await Promise.all([
      repos.threads.bakeComposedSystemPrompt(thread.id, {
        expectedCurrentAgent: "agent-one",
        composedSystemPrompt: "winner-prompt",
        bakedSkillSlugs: ["winner-skill"],
      }),
      repos.threads.bakeComposedSystemPrompt(thread.id, {
        expectedCurrentAgent: "agent-one",
        composedSystemPrompt: "loser-prompt",
        bakedSkillSlugs: ["loser-skill"],
      }),
    ]);

    expect(winner.composedSystemPrompt).toBe(loser.composedSystemPrompt);
    expect(winner.bakedSkillSlugs).toEqual(loser.bakedSkillSlugs);
    expect(["winner-prompt", "loser-prompt"]).toContain(winner.composedSystemPrompt);
    const persisted = await repos.threads.findById(thread.id);
    expect(persisted?.composedSystemPrompt).toBe(winner.composedSystemPrompt);
    expect(persisted?.bakedSkillSlugs).toEqual(winner.bakedSkillSlugs);
  });

  it("re-resolves first-turn bake when an agent rebind wins between compose and CAS", async () => {
    const { repos, orchestrator, workbench, systemTexts } = await setupOrchestrator((id) =>
      seedTwoAgentPackage(id),
    );
    const thread = await repos.threads.create({
      userId: "user-1",
      workbenchId: workbench.id,
      currentAgent: "agent-one",
    });
    const bakeInputs: Array<{ expectedCurrentAgent: string | null; prompt: string }> = [];
    const originalBake = repos.threads.bakeComposedSystemPrompt.bind(repos.threads);
    let injectedRebind = false;
    repos.threads.bakeComposedSystemPrompt = async (id, input) => {
      bakeInputs.push({
        expectedCurrentAgent: input.expectedCurrentAgent ?? null,
        prompt: input.composedSystemPrompt,
      });
      if (!injectedRebind) {
        injectedRebind = true;
        const rebound = await repos.threads.updateCurrentAgent(id, "agent-two");
        expect(rebound?.currentAgent).toBe("agent-two");
      }
      return originalBake(id, input);
    };

    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "hello",
      treeBudget: createDefaultTreeBudget(),
    });
    for await (const _event of handle.events) {
      // drain
    }

    expect(bakeInputs.map((input) => input.expectedCurrentAgent)).toEqual([
      "agent-one",
      "agent-two",
    ]);
    expect(bakeInputs[0]?.prompt).toContain("Agent A body.");
    expect(bakeInputs[1]?.prompt).toContain("Agent B body.");
    expect(systemTexts[0]).toContain("Agent B body.");
    expect(systemTexts[0]).not.toContain("Agent A body.");
    const persisted = await repos.threads.findById(thread.id);
    expect(persisted).toMatchObject({
      currentAgent: "agent-two",
      bakedSkillSlugs: [],
    });
    expect(persisted?.composedSystemPrompt).toContain("Agent B body.");
  });

  it("re-bakes legacy raw body when systemPrompt is set but bakedSkillSlugs is null", async () => {
    let packageRepository!: ReturnType<typeof createInMemoryPackageStore>;
    const { repos, workbench } = await setupOrchestrator((id) => {
      packageRepository = seedPackage(id, [skillRecord(id, "skill-one")]);
      return packageRepository;
    });
    const toolRegistry = createInvokeRegistry(repos, packageRepository);
    const legacyPrompt = "Legacy agent body without bake metadata.";
    const thread = await repos.threads.create({
      userId: "user-1",
      workbenchId: workbench.id,
      currentAgent: "agent-one",
      systemPrompt: legacyPrompt,
    });
    expect(thread.bakedSkillSlugs ?? null).toBeNull();
    expect(thread.composedSystemPrompt).toBeNull();

    const assembled = await assembleNextTurnContext({
      thread,
      turns: [],
      blocks: [],
      packageRepository,
      toolRegistry,
      persistBake: true,
      bakeComposedSystemPrompt: repos.threads.bakeComposedSystemPrompt.bind(repos.threads),
    });

    expect(assembled.systemPrompt).not.toBe(legacyPrompt);
    expect(assembled.systemPrompt).toContain("skill-one");
    const persisted = await repos.threads.findById(thread.id);
    expect(persisted?.composedSystemPrompt).toBe(assembled.systemPrompt);
    expect(persisted?.bakedSkillSlugs).toEqual(["skill-one"]);
  });

  it("does not double-bake pre-migration fully baked composedSystemPrompt when bakedSkillSlugs is null", async () => {
    let packageRepository!: ReturnType<typeof createInMemoryPackageStore>;
    const { repos, workbench } = await setupOrchestrator((id) => {
      packageRepository = seedPackage(id, [skillRecord(id, "skill-one")], "Agent body.");
      return packageRepository;
    });
    const toolRegistry = createInvokeRegistry(repos, packageRepository);
    const resolved = await packageRepository.getAgentWithLinkedSkills(
      workbench.id,
      "user-1",
      "agent-one",
    );
    const legacyFullyBaked = assembleComposedSystemPrompt({
      basePrompt: "Stale pre-migration baked body that must not be rebaked.",
      skillsSystemPromptSection: renderSkillsSystemPromptSection(resolved.skills),
    });
    expect(legacyFullyBaked).toContain(SKILLS_CATALOG_PROMPT_MARKER);
    expect(legacyFullyBaked).toContain(RUNTIME_URI_SYSTEM_INSTRUCTION);

    const created = await repos.threads.create({
      userId: "user-1",
      workbenchId: workbench.id,
      currentAgent: "agent-one",
    });
    const legacyThread = {
      ...created,
      composedSystemPrompt: legacyFullyBaked,
      systemPrompt: null,
      bakedSkillSlugs: null,
    };

    const assembled = await assembleNextTurnContext({
      thread: legacyThread,
      turns: [],
      blocks: [],
      packageRepository,
      toolRegistry,
      persistBake: true,
      bakeComposedSystemPrompt: repos.threads.bakeComposedSystemPrompt.bind(repos.threads),
    });

    expect(assembled.systemPrompt).not.toContain("Stale pre-migration baked body");
    expect(assembled.systemPrompt).toContain("Agent body.");
    expect(assembled.systemPrompt).toContain("skill-one");
    expect(assembled.systemPrompt.split(SKILLS_CATALOG_PROMPT_MARKER)).toHaveLength(2);
    expect(assembled.systemPrompt.split(RUNTIME_URI_SYSTEM_INSTRUCTION)).toHaveLength(2);

    const persisted = await repos.threads.findById(created.id);
    expect(persisted?.composedSystemPrompt).toBe(assembled.systemPrompt);
    expect(persisted?.bakedSkillSlugs).toEqual(["skill-one"]);
  });

  it.each([
    ["zero-skill package listed first", true],
    ["one-skill package listed first", false],
  ])("compare-and-swap bake at assembly: concurrent zero-skill vs one-skill callers share winner (%s)", async (_label, zeroSkillPackageFirst) => {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
    const workbench = await workbenchRepo.create({ userId: "user-1", title: "WB" });
    const nonInvocableSkill = skillRecord(workbench.id, "skill-non-invocable");
    const invocableSkill = skillRecord(workbench.id, "skill-invocable");
    const zeroSkillPackage = seedPackageWithoutInvoke(workbench.id, [nonInvocableSkill]);
    const oneSkillPackage = seedPackage(workbench.id, [invocableSkill], "Agent body.");
    const [packageA, packageB] = zeroSkillPackageFirst
      ? [zeroSkillPackage, oneSkillPackage]
      : [oneSkillPackage, zeroSkillPackage];
    const toolRegistryA = createInvokeRegistry(repos, packageA);
    const toolRegistryB = createInvokeRegistry(repos, packageB);
    const thread = await repos.threads.create({
      userId: "user-1",
      workbenchId: workbench.id,
      currentAgent: "agent-one",
    });
    const bake = repos.threads.bakeComposedSystemPrompt.bind(repos.threads);
    const baseInput = {
      thread,
      turns: [],
      blocks: [],
      persistBake: true,
      bakeComposedSystemPrompt: bake,
    };

    const [first, second] = await Promise.all([
      assembleNextTurnContext({
        ...baseInput,
        packageRepository: packageA,
        toolRegistry: toolRegistryA,
      }),
      assembleNextTurnContext({
        ...baseInput,
        packageRepository: packageB,
        toolRegistry: toolRegistryB,
      }),
    ]);

    const winnerSlugs = first.thread.bakedSkillSlugs;
    const advertisesInvoke = bakedSkillSetAdvertisesInvoke(winnerSlugs);
    const invokeNames = (tools: { name: string }[]) => tools.map((tool) => tool.name);

    expect(first.systemPrompt).toBe(second.systemPrompt);
    expect(first.thread.bakedSkillSlugs).toEqual(second.thread.bakedSkillSlugs);
    expect(invokeNames(first.tools)).toEqual(invokeNames(second.tools));
    expect(invokeNames(first.tools).includes("invoke")).toBe(advertisesInvoke);

    const persisted = await repos.threads.findById(thread.id);
    expect(persisted?.composedSystemPrompt).toBe(first.systemPrompt);
    expect(persisted?.bakedSkillSlugs).toEqual(winnerSlugs);
    if (advertisesInvoke) {
      expect(winnerSlugs).toEqual(["skill-invocable"]);
    } else {
      expect(winnerSlugs).toEqual([]);
    }
  });
});
