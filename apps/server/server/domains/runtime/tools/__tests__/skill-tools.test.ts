/**
 * Skill invoke dispatcher tests.
 */
import { describe, expect, it } from "vitest";

import type { ResolvedSkill, SkillRecord } from "../../../packages/domain/types.js";
import { createCoreToolRegistrations, createToolRegistry } from "../index.js";
import {
  createInvokeToolRegistration,
  invokeFunctionToolDefinition,
  renderSkillsSystemPromptSection,
} from "../skill-tools.js";
import type { ToolHandler } from "../types.js";

function skillRecord(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: "skill-1",
    projectId: "project-1",
    slug: "metric-extraction",
    body: "# Metric extraction\nExtract metrics from data.",
    meta: { description: "Extract quantitative metrics" },
    files: { "run.py": "print('hi')" },
    packageInstallId: "pkg-1",
    originalContentChecksum: null,
    sourceType: "package",
    enabled: true,
    ...overrides,
  };
}

function resolvedSkill(overrides: Partial<ResolvedSkill> = {}): ResolvedSkill {
  return {
    skill: skillRecord(),
    layer: "project",
    modelInvocable: true,
    userInvocable: true,
    ...overrides,
  };
}

const coreHandler = async () => ({ ok: true });
const coreRegistrations = createCoreToolRegistrations({
  read: coreHandler,
  edit: coreHandler,
  write: coreHandler,
  list: coreHandler,
  search: coreHandler,
  ask_user: coreHandler,
});

function invokeHandler(registry: ReturnType<typeof createToolRegistry>): ToolHandler {
  const registration = registry.getRegistration("invoke");
  if (registration?.execution.type !== "server") throw new Error("missing invoke handler");
  return registration.execution.handler as ToolHandler;
}

describe("invokeFunctionToolDefinition", () => {
  it("accepts only skillname with additionalProperties false", () => {
    expect(invokeFunctionToolDefinition().inputSchema).toMatchObject({
      type: "object",
      required: ["skillname"],
      additionalProperties: false,
      properties: { skillname: { type: "string" } },
    });
  });
});

describe("renderSkillsSystemPromptSection", () => {
  it("returns undefined when no model-invocable skills exist", () => {
    expect(
      renderSkillsSystemPromptSection([resolvedSkill({ modelInvocable: false })]),
    ).toBeUndefined();
  });

  it("renders deterministic slug order with slug and description only", () => {
    const section = renderSkillsSystemPromptSection([
      resolvedSkill({ skill: skillRecord({ slug: "z-skill", meta: { description: "Zed" } }) }),
      resolvedSkill({ skill: skillRecord({ slug: "a-skill", meta: { description: "Alpha" } }) }),
    ]);

    expect(section).toContain("Available skills");
    const aIndex = section?.indexOf("- a-skill:");
    const zIndex = section?.indexOf("- z-skill:");
    expect(aIndex).toBeGreaterThan(-1);
    expect(zIndex).toBeGreaterThan(-1);
    expect(aIndex).toBeLessThan(zIndex ?? 0);
    expect(section).toContain("- a-skill: Alpha");
    expect(section).toContain("- z-skill: Zed");
    expect(section).not.toContain("inputSchema");
  });
});

describe("createInvokeToolRegistration", () => {
  function registerInvoke(input: {
    skills: ResolvedSkill[];
    bakedSkillSlugs?: string[] | null;
    currentAgent?: string | null;
  }) {
    const registry = createToolRegistry({ registrations: coreRegistrations });
    registry.register(
      createInvokeToolRegistration({
        packageRepository: {
          getAgentWithLinkedSkills: async () => ({ skills: input.skills }),
        } as never,
        findThreadById: async () => ({
          projectId: "project-1",
          userId: "user-1",
          currentAgent: "currentAgent" in input ? (input.currentAgent ?? null) : "agent-one",
          bakedSkillSlugs:
            "bakedSkillSlugs" in input ? (input.bakedSkillSlugs ?? null) : ["metric-extraction"],
        }),
      }),
    );
    return invokeHandler(registry);
  }

  it("returns a no-execution boundary for a baked model-invocable skill", async () => {
    const handler = registerInvoke({ skills: [resolvedSkill()] });

    const output = await handler(
      { skillname: "metric-extraction", message: "hi" },
      {
        signal: new AbortController().signal,
        threadId: "thread-1",
        turnId: "turn-1",
        agentSlug: "agent-one",
      },
    );

    expect(output).toEqual({
      isError: true,
      output:
        'Skill "metric-extraction" is available as prompt context, but executable skill runtime is disabled in Meridian.',
    });
  });

  it("returns a recoverable error listing baked ∩ invocable slugs for unknown skillname", async () => {
    const handler = registerInvoke({
      bakedSkillSlugs: ["alpha", "beta"],
      skills: [
        resolvedSkill({ skill: skillRecord({ slug: "alpha" }) }),
        resolvedSkill({ skill: skillRecord({ slug: "beta" }) }),
        resolvedSkill({ skill: skillRecord({ slug: "gamma" }) }),
      ],
    });

    const output = await handler(
      { skillname: "missing" },
      {
        signal: new AbortController().signal,
        threadId: "thread-1",
        turnId: "turn-1",
        agentSlug: "agent-one",
      },
    );

    expect(output).toEqual({
      isError: true,
      output: 'Unknown skill "missing". Available skills: alpha, beta',
    });
  });

  it("rejects skills added after bake even when currently resolvable", async () => {
    const handler = registerInvoke({
      bakedSkillSlugs: ["alpha"],
      skills: [
        resolvedSkill({ skill: skillRecord({ slug: "alpha" }) }),
        resolvedSkill({ skill: skillRecord({ slug: "new-skill" }) }),
      ],
    });

    const output = await handler(
      { skillname: "new-skill" },
      {
        signal: new AbortController().signal,
        threadId: "thread-1",
        turnId: "turn-1",
        agentSlug: "agent-one",
      },
    );

    expect(output).toEqual({
      isError: true,
      output: 'Unknown skill "new-skill". Available skills: alpha',
    });
  });

  it("returns no-longer-available when a baked skill is demoted", async () => {
    const handler = registerInvoke({
      bakedSkillSlugs: ["alpha", "beta"],
      skills: [
        resolvedSkill({ skill: skillRecord({ slug: "alpha" }), modelInvocable: false }),
        resolvedSkill({ skill: skillRecord({ slug: "beta" }) }),
      ],
    });

    const output = await handler(
      { skillname: "alpha" },
      {
        signal: new AbortController().signal,
        threadId: "thread-1",
        turnId: "turn-1",
        agentSlug: "agent-one",
      },
    );

    expect(output).toEqual({
      isError: true,
      output: 'Skill "alpha" is no longer available. Available skills: beta',
    });
  });

  it("returns no-longer-available when a baked skill is deleted", async () => {
    const handler = registerInvoke({
      bakedSkillSlugs: ["alpha", "beta"],
      skills: [resolvedSkill({ skill: skillRecord({ slug: "beta" }) })],
    });

    const output = await handler(
      { skillname: "alpha" },
      {
        signal: new AbortController().signal,
        threadId: "thread-1",
        turnId: "turn-1",
        agentSlug: "agent-one",
      },
    );

    expect(output).toEqual({
      isError: true,
      output: 'Skill "alpha" is no longer available. Available skills: beta',
    });
  });

  it("returns a tool error when skillname is missing", async () => {
    const handler = registerInvoke({ skills: [resolvedSkill()] });

    const output = await handler(
      { message: "hi" },
      {
        signal: new AbortController().signal,
        threadId: "thread-1",
        turnId: "turn-1",
        agentSlug: "agent-one",
      },
    );

    expect(output).toEqual({ isError: true, output: "invoke requires skillname (string)." });
  });

  it("requires an agent-bound baked skill context", async () => {
    const noAgent = registerInvoke({ skills: [resolvedSkill()], currentAgent: null });
    await expect(
      noAgent(
        { skillname: "metric-extraction" },
        {
          signal: new AbortController().signal,
          threadId: "thread-1",
          turnId: "turn-1",
          agentSlug: null,
        },
      ),
    ).resolves.toEqual({ isError: true, output: "Thread has no agent-bound skill context." });

    const notBaked = registerInvoke({ skills: [resolvedSkill()], bakedSkillSlugs: null });
    await expect(
      notBaked(
        { skillname: "metric-extraction" },
        {
          signal: new AbortController().signal,
          threadId: "thread-1",
          turnId: "turn-1",
          agentSlug: "agent-one",
        },
      ),
    ).resolves.toEqual({ isError: true, output: "Thread skill catalog is not baked yet." });
  });
});
