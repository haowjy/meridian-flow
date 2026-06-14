// @ts-nocheck
/** Route-core tests for GET project agents catalog: ownership gating and catalog merge rules. */
import { describe, expect, it } from "vitest";
import { createInMemoryPackageStore } from "../domains/packages/index.js";
import { createInMemoryProjectRepository as createProjects } from "../domains/projects/index.js";
import { handleGetProjectAgentsRequest } from "./project-agents-route.js";

describe("project agents route core", () => {
  it("returns builtin and project agents with project winning on slug collision", async () => {
    const projectRepo = createProjects();
    const packageRepository = createInMemoryPackageStore({
      packages: [
        {
          id: "pkg-1",
          projectId: "project-1",
          packageName: "Volumetry Pipeline",
          visibility: "private",
        },
      ],
      agents: [
        {
          id: "builtin-general",
          projectId: null,
          slug: "general",
          body: "",
          meta: { name: "General", description: "Built-in fallback", mode: "primary" },
          config: {},
          packageInstallId: null,
          originalContentChecksum: null,
          sourceType: "builtin",
          enabled: true,
        },
        {
          id: "wb-segmentation",
          projectId: "project-1",
          slug: "segmentation",
          body: "",
          meta: { name: "Segmentation Agent", description: "Segments cells", mode: "primary" },
          config: {},
          packageInstallId: "pkg-1",
          originalContentChecksum: "abc",
          sourceType: "package",
          enabled: true,
        },
        {
          id: "wb-subagent",
          projectId: "project-1",
          slug: "reviewer",
          body: "",
          meta: { name: "Reviewer", description: "Hidden subagent", mode: "subagent" },
          config: {},
          packageInstallId: null,
          originalContentChecksum: null,
          sourceType: "user",
          enabled: true,
        },
      ],
    });
    await projectRepo.create({ id: "project-1", userId: "user-1" });

    await expect(
      handleGetProjectAgentsRequest(
        { projectRepo, packageRepository },
        { projectId: "project-1", userId: "user-1" },
      ),
    ).resolves.toEqual({
      agents: [
        {
          slug: "general",
          name: "General",
          description: "Built-in fallback",
          source: "builtin",
          packageName: null,
        },
        {
          slug: "segmentation",
          name: "Segmentation Agent",
          description: "Segments cells",
          source: "package",
          packageName: "Volumetry Pipeline",
        },
      ],
    });
  });

  it("rejects non-owner access before listing agents", async () => {
    const projectRepo = createProjects();
    const packageRepository = createInMemoryPackageStore();
    await projectRepo.create({ id: "project-1", userId: "owner" });

    await expect(
      handleGetProjectAgentsRequest(
        { projectRepo, packageRepository },
        { projectId: "project-1", userId: "intruder" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
