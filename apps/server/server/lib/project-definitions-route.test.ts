// @ts-nocheck
/** Route-core tests for definition save, revision list, and restore flows. */
import { describe, expect, it } from "vitest";
import {
  agentDefinitionContentChecksum,
  normalizeAgentMeta,
} from "../domains/packages/domain/mars-source.js";
import { listProjectLibraryInventory } from "../domains/packages/domain/project-library.js";
import { createInMemoryPackageStore } from "../domains/packages/index.js";
import { createInMemoryProjectRepository as createProjects } from "../domains/projects/index.js";
import {
  handleGetAgentDefinitionRequest,
  handleListAgentDefinitionRevisionsRequest,
  handlePatchAgentSkillLinkRequest,
  handlePutAgentDefinitionRequest,
  handleRestoreAgentDefinitionOriginalRequest,
} from "./project-definitions-route.js";

describe("project definitions route core", () => {
  it("saves an agent, appends a revision, and marks edited state against pristine checksum", async () => {
    const projectRepo = createProjects();
    const pristineChecksum = agentDefinitionContentChecksum({
      body: "Original instructions",
      meta: { name: "Segmentation Agent", mode: "primary" },
      config: {},
    });
    const packageRepository = createInMemoryPackageStore({
      agents: [
        {
          id: "agent-1",
          projectId: "project-1",
          slug: "segmentation",
          body: "Original instructions",
          meta: { name: "Segmentation Agent", mode: "primary" },
          config: {},
          packageInstallId: "pkg-1",
          originalContentChecksum: pristineChecksum,
          sourceType: "package",
          enabled: true,
        },
      ],
      agentRevisions: [
        {
          id: "rev-0",
          agentDefinitionId: "agent-1",
          contentChecksum: pristineChecksum,
          body: "Original instructions",
          meta: { name: "Segmentation Agent", mode: "primary" },
          config: {},
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
    await projectRepo.create({ id: "project-1", userId: "user-1" });

    const saved = await handlePutAgentDefinitionRequest(
      { projectRepo, packageRepository },
      {
        projectId: "project-1",
        userId: "user-1",
        slug: "segmentation",
        body: {
          body: "Edited instructions",
          meta: { name: "Segmentation Agent", mode: "primary" },
        },
      },
    );

    expect(saved.agent.isEdited).toBe(true);
    expect(saved.agent.body).toBe("Edited instructions");

    const revisions = await handleListAgentDefinitionRevisionsRequest(
      { projectRepo, packageRepository },
      { projectId: "project-1", userId: "user-1", slug: "segmentation" },
    );
    expect(revisions.revisions).toHaveLength(2);

    const restored = await handleRestoreAgentDefinitionOriginalRequest(
      { projectRepo, packageRepository },
      { projectId: "project-1", userId: "user-1", slug: "segmentation" },
    );
    expect(restored.agent.body).toBe("Original instructions");
    expect(restored.agent.isEdited).toBe(false);

    const afterRestore = await handleListAgentDefinitionRevisionsRequest(
      { projectRepo, packageRepository },
      { projectId: "project-1", userId: "user-1", slug: "segmentation" },
    );
    expect(afterRestore.revisions).toHaveLength(3);
  });

  it("clears library edited badge after description save and restore original", async () => {
    const projectRepo = createProjects();
    const pristineMeta = normalizeAgentMeta({
      name: "Segmentation Agent",
      description: "Original description",
      mode: "primary",
    });
    const pristineChecksum = agentDefinitionContentChecksum({
      body: "Original instructions",
      meta: pristineMeta,
      config: {},
    });
    const packageRepository = createInMemoryPackageStore({
      agents: [
        {
          id: "agent-1",
          projectId: "project-1",
          slug: "segmentation",
          body: "Original instructions",
          meta: pristineMeta,
          config: {},
          packageInstallId: "pkg-1",
          originalContentChecksum: pristineChecksum,
          sourceType: "package",
          enabled: true,
        },
      ],
      agentRevisions: [
        {
          id: "rev-0",
          agentDefinitionId: "agent-1",
          contentChecksum: pristineChecksum,
          body: "Original instructions",
          meta: pristineMeta,
          config: {},
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
    await projectRepo.create({ id: "project-1", userId: "user-1" });

    await handlePutAgentDefinitionRequest(
      { projectRepo, packageRepository },
      {
        projectId: "project-1",
        userId: "user-1",
        slug: "segmentation",
        body: {
          body: "Original instructions",
          meta: normalizeAgentMeta({
            ...pristineMeta,
            description: "Edited description",
          }),
        },
      },
    );

    const restored = await handleRestoreAgentDefinitionOriginalRequest(
      { projectRepo, packageRepository },
      { projectId: "project-1", userId: "user-1", slug: "segmentation" },
    );
    expect(restored.agent.isEdited).toBe(false);

    const library = await packageRepository.transaction((tx) =>
      listProjectLibraryInventory(tx, "project-1"),
    );
    expect(library.agents.find((agent) => agent.slug === "segmentation")?.isEdited).toBe(false);
  });

  it("patches modelInvocable without appending a revision", async () => {
    const projectRepo = createProjects();
    const pristineMeta = normalizeAgentMeta({
      name: "Segmentation Agent",
      mode: "primary",
      skills: ["segment"],
    });
    const pristineChecksum = agentDefinitionContentChecksum({
      body: "Original instructions",
      meta: pristineMeta,
      config: {},
    });
    const packageRepository = createInMemoryPackageStore({
      agents: [
        {
          id: "agent-1",
          projectId: "project-1",
          slug: "segmentation",
          body: "Original instructions",
          meta: pristineMeta,
          config: {},
          packageInstallId: "pkg-1",
          originalContentChecksum: pristineChecksum,
          sourceType: "package",
          enabled: true,
        },
      ],
      skills: [
        {
          id: "skill-1",
          projectId: "project-1",
          slug: "segment",
          body: "body",
          meta: { name: "Segment" },
          files: {},
          packageInstallId: "pkg-1",
          originalContentChecksum: null,
          sourceType: "package",
          enabled: true,
        },
      ],
      agentSkills: [
        {
          agentDefinitionId: "agent-1",
          skillId: "skill-1",
          ordinal: 0,
          modelInvocable: true,
        },
      ],
    });
    await projectRepo.create({ id: "project-1", userId: "user-1" });

    const patched = await handlePatchAgentSkillLinkRequest(
      { projectRepo, packageRepository },
      {
        projectId: "project-1",
        userId: "user-1",
        slug: "segmentation",
        skillSlug: "segment",
        body: { modelInvocable: false },
      },
    );
    expect(patched.skillLinks[0]?.modelInvocable).toBe(false);
    expect(patched.isEdited).toBe(false);

    const revisions = await handleListAgentDefinitionRevisionsRequest(
      { projectRepo, packageRepository },
      { projectId: "project-1", userId: "user-1", slug: "segmentation" },
    );
    expect(revisions.revisions).toHaveLength(0);
  });

  it("loads a project agent definition for the Library editor", async () => {
    const projectRepo = createProjects();
    const packageRepository = createInMemoryPackageStore({
      agents: [
        {
          id: "agent-1",
          projectId: "project-1",
          slug: "segmentation",
          body: "Original instructions",
          meta: { name: "Segmentation Agent", mode: "primary" },
          config: {},
          packageInstallId: "pkg-1",
          originalContentChecksum: null,
          sourceType: "package",
          enabled: true,
        },
      ],
    });
    await projectRepo.create({ id: "project-1", userId: "user-1" });

    const loaded = await handleGetAgentDefinitionRequest(
      { projectRepo, packageRepository },
      { projectId: "project-1", userId: "user-1", slug: "segmentation" },
    );

    expect(loaded.agent.slug).toBe("segmentation");
    expect(loaded.agent.body).toBe("Original instructions");
  });
});
