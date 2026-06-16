/** Route-core tests for turn-context preview: owner gating, capture enablement, assembly parity. */
import { describe, expect, it } from "vitest";
import type {
  AgentDefinitionRecord,
  AgentSkillLinkRecord,
  SkillRecord,
} from "../domains/packages/domain/types.js";
import { createInMemoryPackageStore } from "../domains/packages/index.js";
import { createInMemoryProjectRepository } from "../domains/projects/index.js";
import { assembleNextTurnContext } from "../domains/runtime/loop/turn-context-assembly.js";
import {
  createInMemoryModelRequestDebugStore,
  createNoopModelRequestDebugStore,
  extractSystemMessageTexts,
} from "../domains/runtime/model-request-debug/index.js";
import {
  createCoreToolRegistrations,
  createInvokeToolRegistration,
  createToolExecutor,
  createToolRegistry,
} from "../domains/runtime/tools/index.js";
import { createInMemoryRepositories } from "../domains/threads/index.js";
import { handleGetTurnContextPreview } from "./turn-context-preview-route.js";

const coreHandler = async () => ({ ok: true });
const coreRegistrations = createCoreToolRegistrations({
  read: coreHandler,
  edit: coreHandler,
  write: coreHandler,
  list: coreHandler,
  search: coreHandler,
  ask_user: coreHandler,
});

function skillRecord(projectId: string, slug: string): SkillRecord {
  return {
    id: `skill-${slug}`,
    projectId,
    slug,
    body: "# Skill",
    meta: { description: `Run ${slug}` },
    files: {},
    packageInstallId: "pkg-1",
    originalContentChecksum: null,
    sourceType: "package",
    enabled: true,
  };
}

function seedPackage(projectId: string) {
  const skill = skillRecord(projectId, "skill-one");
  const agent: AgentDefinitionRecord = {
    id: "agent-1",
    projectId,
    slug: "agent-one",
    body: "You are a helpful agent.",
    meta: { model: "mock-model", effort: "medium" },
    config: {},
    packageInstallId: "pkg-1",
    originalContentChecksum: null,
    sourceType: "package",
    enabled: true,
  };
  const agentSkills: AgentSkillLinkRecord[] = [
    { agentDefinitionId: agent.id, skillId: skill.id, modelInvocable: true },
  ];
  return createInMemoryPackageStore({ agents: [agent], skills: [skill], agentSkills });
}

function previewDeps(input: {
  repos: ReturnType<typeof createInMemoryRepositories>;
  projectRepo: ReturnType<typeof createInMemoryProjectRepository>;
  modelRequestDebug: ReturnType<typeof createInMemoryModelRequestDebugStore>;
  projectId: string;
}) {
  const packageRepository = seedPackage(input.projectId);
  const toolRegistry = createToolRegistry({
    registrations: [
      ...coreRegistrations,
      createInvokeToolRegistration({
        packageRepository,
        findThreadById: async (threadId) => {
          const thread = await input.repos.threads.findById(threadId);
          if (!thread) return null;
          return {
            projectId: thread.projectId,
            userId: thread.userId,
            currentAgent: thread.currentAgent,
            bakedSkillSlugs: thread.bakedSkillSlugs ?? null,
          };
        },
      }),
    ],
  });
  const toolExecutor = createToolExecutor(toolRegistry);

  return {
    repos: input.repos,
    projectRepo: input.projectRepo,
    modelRequestDebug: input.modelRequestDebug,
    packageRepository,
    toolRegistry,
    toolExecutor,
  };
}

describe("turn-context preview route core", () => {
  it("returns 404 when capture is disabled", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "WB" });
    const thread = await repos.threads.create({
      id: "thread-1",
      projectId: project.id,
      userId: "user-1",
      title: null,
    });

    await expect(
      handleGetTurnContextPreview(
        {
          repos,
          projectRepo,
          modelRequestDebug: createNoopModelRequestDebugStore(),
          packageRepository: createInMemoryPackageStore(),
          toolRegistry: createToolRegistry({ registrations: coreRegistrations }),
          toolExecutor: createToolExecutor(
            createToolRegistry({ registrations: coreRegistrations }),
          ),
        },
        { threadId: thread.id, userId: "user-1" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns 404 for non-owner before assembling preview", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "owner", title: "WB" });
    const thread = await repos.threads.create({
      id: "thread-1",
      projectId: project.id,
      userId: "owner",
      title: null,
      currentAgent: "agent-one",
    });
    const deps = previewDeps({
      repos,
      projectRepo,
      modelRequestDebug: createInMemoryModelRequestDebugStore(),
      projectId: project.id,
    });

    await expect(
      handleGetTurnContextPreview(deps, { threadId: thread.id, userId: "intruder" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns preview for owner when capture is enabled without persisting bake", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "WB" });
    const thread = await repos.threads.create({
      id: "thread-1",
      projectId: project.id,
      userId: "user-1",
      title: null,
      currentAgent: "agent-one",
    });
    const deps = previewDeps({
      repos,
      projectRepo,
      modelRequestDebug: createInMemoryModelRequestDebugStore(),
      projectId: project.id,
    });

    const preview = await handleGetTurnContextPreview(deps, {
      threadId: thread.id,
      userId: "user-1",
    });

    expect(preview.agentSlug).toBe("agent-one");
    expect(preview.baked).toBe(false);
    expect(preview.systemPrompt).toContain("You are a helpful agent.");
    expect(preview.systemPrompt).toContain("Available skills");
    expect(preview.tools.map((tool) => tool.name)).toContain("invoke");
    expect(preview.gatewayParams.model).toBe("mock-model");

    const persisted = await repos.threads.findById(thread.id);
    expect(persisted?.composedSystemPrompt).toBeNull();
    expect(persisted?.bakedSkillSlugs ?? null).toBeNull();
  });

  it("matches the orchestrator assembly path for the same thread state", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "WB" });
    const thread = await repos.threads.create({
      id: "thread-1",
      projectId: project.id,
      userId: "user-1",
      title: null,
      currentAgent: "agent-one",
    });
    const deps = previewDeps({
      repos,
      projectRepo,
      modelRequestDebug: createInMemoryModelRequestDebugStore(),
      projectId: project.id,
    });

    const preview = await handleGetTurnContextPreview(deps, {
      threadId: thread.id,
      userId: "user-1",
    });

    const persistedAssembly = await assembleNextTurnContext({
      thread,
      turns: [],
      blocks: [],
      packageRepository: deps.packageRepository,
      toolRegistry: deps.toolRegistry,
      baseTools: deps.toolExecutor.getDefinitions?.(),
      persistBake: true,
      bakeComposedSystemPrompt: repos.threads.bakeComposedSystemPrompt.bind(repos.threads),
    });

    expect(preview.systemPrompt).toBe(persistedAssembly.systemPrompt);
    expect(preview.tools.map((tool) => tool.name).sort()).toEqual(
      persistedAssembly.tools.map((tool) => tool.name).sort(),
    );
    expect(extractSystemMessageTexts(persistedAssembly.generateRequest.messages)[0]).toBe(
      preview.systemPrompt,
    );
  });
});
