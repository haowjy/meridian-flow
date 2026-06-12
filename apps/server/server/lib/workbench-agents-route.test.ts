// @ts-nocheck
/** Route-core tests for GET workbench agents catalog: ownership gating and catalog merge rules. */
import { describe, expect, it } from "vitest";
import { createInMemoryPackageStore } from "../domains/packages/index.js";
import { createInMemoryWorkbenchRepository as createWorkbenchs } from "../domains/workbenches/index.js";
import { handleGetWorkbenchAgentsRequest } from "./workbench-agents-route.js";

describe("workbench agents route core", () => {
  it("returns builtin and workbench agents with workbench winning on slug collision", async () => {
    const workbenchRepo = createWorkbenchs();
    const packageRepository = createInMemoryPackageStore({
      packages: [
        {
          id: "pkg-1",
          workbenchId: "workbench-1",
          packageName: "Volumetry Pipeline",
          visibility: "private",
        },
      ],
      agents: [
        {
          id: "builtin-general",
          workbenchId: null,
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
          workbenchId: "workbench-1",
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
          workbenchId: "workbench-1",
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
    await workbenchRepo.create({ id: "workbench-1", userId: "user-1" });

    await expect(
      handleGetWorkbenchAgentsRequest(
        { workbenchRepo, packageRepository },
        { workbenchId: "workbench-1", userId: "user-1" },
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
    const workbenchRepo = createWorkbenchs();
    const packageRepository = createInMemoryPackageStore();
    await workbenchRepo.create({ id: "workbench-1", userId: "owner" });

    await expect(
      handleGetWorkbenchAgentsRequest(
        { workbenchRepo, packageRepository },
        { workbenchId: "workbench-1", userId: "intruder" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
