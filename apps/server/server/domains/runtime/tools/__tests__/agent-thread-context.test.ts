/**
 * Agent-bound thread context tests: system prompt baking, gateway params, tool ads.
 */
import { describe, expect, it } from "vitest";
import type { SkillRecord } from "../../../packages/domain/types.js";
import { createInMemoryAgentRevisionStore } from "../../../packages/index.js";
import { buildContext } from "../../loop/context-builder.js";
import {
  agentGatewayMetaToGenerateParams,
  resolveAgentThreadTurnContext,
} from "../agent-thread-context.js";
import { createCoreToolRegistrations, createToolRegistry } from "../index.js";
import { renderSkillsSystemPromptSection } from "../skill-tools.js";

const coreHandler = async () => ({ ok: true });
const coreRegistrations = createCoreToolRegistrations({
  work: coreHandler,
  write: coreHandler,
  ls: coreHandler,
  search: coreHandler,
  ask_user: coreHandler,
});

function threadFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-1",
    projectId: "project-1",
    workId: null,
    userId: "user-1",
    kind: "primary" as const,
    status: "idle" as const,
    title: null,
    slug: null,
    composedSystemPrompt: null,
    bakedSkillSlugs: null,
    systemPrompt: null,
    workingState: null,
    currentAgent: "agent-one",
    agentDefinitionRevisionId: null,
    agentName: null,
    activeLeafTurnId: null,
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
  async function binding() {
    const agentRevisions = createInMemoryAgentRevisionStore({
      threadExists: async (id) => id === "thread-1",
    });
    const source = {
      coordinate: "fixture/agents",
      files: {
        "agents/agent-one.md":
          "---\nname: Writer\nmodel: retained-model\neffort: xhigh\n---\nOriginal prompt.",
      },
    };
    const revision = (await agentRevisions.installSource(source)).definitions[0];
    await agentRevisions.bindThread("thread-1", revision.id);
    const toolRegistry = createToolRegistry({ registrations: coreRegistrations });
    return { agentRevisions, source, revision, toolRegistry };
  }

  it("uses the retained model/body despite catalog advancement and an unrelated display slug", async () => {
    const fixture = await binding();
    await fixture.agentRevisions.selectRevision({
      ownerUserId: "user-1",
      logicalKey: "writer",
      revisionId: fixture.revision.id,
    });
    const next = (
      await fixture.agentRevisions.installSource({
        ...fixture.source,
        files: {
          "agents/agent-one.md":
            "---\nname: Writer\nmodel: replacement-model\n---\nReplacement prompt.",
        },
      })
    ).definitions[0];
    await fixture.agentRevisions.selectRevision({
      ownerUserId: "user-1",
      logicalKey: "writer",
      revisionId: next.id,
      expectedRevisionId: fixture.revision.id,
    });
    const context = await resolveAgentThreadTurnContext({
      ...fixture,
      thread: threadFixture({ currentAgent: "other-slug" }),
      baseTools: fixture.toolRegistry.getDefinitions(),
    });
    expect(context.gatewayParams).toEqual({
      model: "retained-model",
      reasoning: { effort: "max" },
    });
    expect(context.agentBody).toBe("Original prompt.");
    expect(context.agentSlug).toBe("agent-one");
  });

  it("refuses an unbound conversation instead of silently selecting the gateway default", async () => {
    const fixture = await binding();
    await expect(
      resolveAgentThreadTurnContext({
        ...fixture,
        thread: threadFixture({ id: "unbound" }),
        baseTools: undefined,
      }),
    ).rejects.toThrow("no retained Agent binding");
  });

  it("uses the same retained configuration preparation for a child", async () => {
    const fixture = await binding();
    const context = await resolveAgentThreadTurnContext({
      ...fixture,
      thread: threadFixture({ kind: "subagent" }),
      baseTools: undefined,
    });
    expect(context.agentBody).toBe(
      "Original prompt.\n\nYou are a subagent. Finish by calling return_result with a report for your parent. If blocked or you need an answer, report that to your parent.",
    );
    expect(context.gatewayParams.model).toBe("retained-model");
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
