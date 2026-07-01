/**
 * Agent-bound thread context tests: system prompt baking, gateway params, tool ads.
 */
import { describe, expect, it } from "vitest";
import type {
  AgentDefinitionRecord,
  AgentSkillLinkRecord,
  SkillRecord,
} from "../../../packages/domain/types.js";
import { createInMemoryPackageStore } from "../../../packages/index.js";
import { buildContext } from "../../loop/context-builder.js";
import {
  agentGatewayMetaToGenerateParams,
  resolveAgentThreadTurnContext,
} from "../agent-thread-context.js";
import {
  createCoreToolRegistrations,
  createInvokeToolRegistration,
  createToolRegistry,
} from "../index.js";
import { renderSkillsSystemPromptSection } from "../skill-tools.js";

const coreHandler = async () => ({ ok: true });
const coreRegistrations = createCoreToolRegistrations({
  write: coreHandler,
  list: coreHandler,
  search: coreHandler,
  ask_user: coreHandler,
});

function seedAgentPackage(agentBody: string, skill: SkillRecord) {
  const agent: AgentDefinitionRecord = {
    id: "agent-1",
    projectId: "project-1",
    slug: "agent-one",
    body: agentBody,
    meta: { model: "claude-sonnet-4-20250514", effort: "high" },
    config: {},
    packageInstallId: "pkg-1",
    originalContentChecksum: null,
    sourceType: "package",
    enabled: true,
  };
  const link: AgentSkillLinkRecord = {
    agentDefinitionId: agent.id,
    skillId: skill.id,
    modelInvocable: true,
  };
  return createInMemoryPackageStore({ agents: [agent], skills: [skill], agentSkills: [link] });
}

function threadFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-1",
    projectId: "project-1",
    workId: null,
    userId: "user-1",
    kind: "primary" as const,
    status: "idle" as const,
    title: null,
    composedSystemPrompt: null,
    bakedSkillSlugs: null,
    systemPrompt: null,
    workingState: null,
    currentAgent: "agent-one",
    aiWriteMode: "direct" as const,
    parentThreadId: null,
    rootThreadId: "thread-1",
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function skill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: "skill-1",
    projectId: "project-1",
    slug: "skill-one",
    body: "# Skill",
    meta: { description: "Run skill" },
    files: {},
    packageInstallId: "pkg-1",
    originalContentChecksum: null,
    sourceType: "package",
    enabled: true,
    ...overrides,
  };
}

function toolRegistry(packageRepository: ReturnType<typeof createInMemoryPackageStore>) {
  return createToolRegistry({
    registrations: [
      ...coreRegistrations,
      createInvokeToolRegistration({
        packageRepository,
        findThreadById: async () => null,
      }),
    ],
  });
}

describe("agentGatewayMetaToGenerateParams", () => {
  it("maps effort levels to reasoning objects", () => {
    expect(agentGatewayMetaToGenerateParams({ effort: "high" })).toEqual({
      reasoning: { effort: "high" },
    });
  });

  it("passes adaptive and disabled through verbatim", () => {
    expect(agentGatewayMetaToGenerateParams({ effort: "adaptive" })).toEqual({
      reasoning: "adaptive",
    });
    expect(agentGatewayMetaToGenerateParams({ effort: "disabled" })).toEqual({
      reasoning: "disabled",
    });
  });
});

describe("resolveAgentThreadTurnContext", () => {
  it("returns gateway model/effort for agent-bound threads", async () => {
    const packageRepository = seedAgentPackage("Agent body prompt.", skill({ meta: {} }));
    const registry = toolRegistry(packageRepository);

    const context = await resolveAgentThreadTurnContext({
      thread: threadFixture(),
      packageRepository,
      toolRegistry: registry,
      baseTools: registry.getDefinitions(),
    });

    expect(context.gatewayParams).toEqual({
      model: "claude-sonnet-4-20250514",
      reasoning: { effort: "high" },
    });
    expect(
      context.tools?.map((tool) => (tool.type === "function" ? tool.name : tool.kind)),
    ).not.toContain("skill-one");
  });

  it("does not advertise invoke or skills section when agent has no model-invocable skills", async () => {
    const packageSkill = skill({ meta: { description: "Hidden skill" } });
    const agent: AgentDefinitionRecord = {
      id: "agent-1",
      projectId: "project-1",
      slug: "agent-one",
      body: "Agent body.",
      meta: {},
      config: {},
      packageInstallId: "pkg-1",
      originalContentChecksum: null,
      sourceType: "package",
      enabled: true,
    };
    const packageRepository = createInMemoryPackageStore({
      agents: [agent],
      skills: [packageSkill],
      agentSkills: [
        { agentDefinitionId: agent.id, skillId: packageSkill.id, modelInvocable: false },
      ],
    });
    const registry = toolRegistry(packageRepository);

    const context = await resolveAgentThreadTurnContext({
      thread: threadFixture(),
      packageRepository,
      toolRegistry: registry,
      baseTools: registry.getDefinitions(),
    });

    expect(context.skillsSystemPromptSection).toBeUndefined();
    expect(
      context.tools?.map((tool) => (tool.type === "function" ? tool.name : tool.kind)),
    ).not.toContain("invoke");
  });

  it("advertises invoke and renders skills section for model-invocable skills", async () => {
    const packageRepository = seedAgentPackage("Agent body.", skill());
    const registry = toolRegistry(packageRepository);

    const context = await resolveAgentThreadTurnContext({
      thread: threadFixture(),
      packageRepository,
      toolRegistry: registry,
      baseTools: registry.getDefinitions(),
    });

    expect(
      context.tools?.map((tool) => (tool.type === "function" ? tool.name : tool.kind)),
    ).toContain("invoke");
    expect(context.skillsSystemPromptSection).toBe(
      renderSkillsSystemPromptSection(context.resolvedSkills),
    );
    expect(context.skillsSystemPromptSection).toContain("skill-one");
    expect(context.skillsSystemPromptSection).not.toContain("inputSchema");
  });
});

describe("buildContext with agent-bound thread", () => {
  it("uses baked agent body and ignores HTTP systemPrompt", () => {
    const context = buildContext({
      thread: threadFixture({
        composedSystemPrompt: "You extract metrics from imaging data.",
        bakedSkillSlugs: [],
        systemPrompt: "HTTP override should be ignored.",
      }),
      turns: [],
      blocks: [],
    });

    const systemText = context.messages[0]?.content[0];
    expect(systemText).toMatchObject({
      type: "text",
      text: expect.stringContaining("You extract metrics from imaging data."),
    });
    expect(systemText).toMatchObject({
      text: expect.not.stringContaining("HTTP override should be ignored."),
    });
  });

  it("appends the skills catalog section to the system prompt", () => {
    const skillsSection = renderSkillsSystemPromptSection([
      { skill: skill(), layer: "project", modelInvocable: true, userInvocable: true },
    ]);
    const context = buildContext({
      thread: threadFixture(),
      turns: [],
      blocks: [],
      skillsSystemPromptSection: skillsSection,
    });

    const systemText = context.messages[0]?.content[0];
    expect(systemText).toMatchObject({
      type: "text",
      text: expect.stringContaining("Available skills"),
    });
    expect(systemText).toMatchObject({ text: expect.stringContaining("- skill-one: Run skill") });
  });
});
