// @ts-nocheck
/** Route-core tests for package update check/apply reconciliation. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyPackageInstall,
  createInMemoryPackageStore,
  importLocalMarsPackage,
} from "../domains/packages/index.js";
import { fetchedMarsSourceFromDirectory } from "../domains/packages/ports/mars-package-fetcher.js";
import { createInMemoryWorkbenchRepository as createWorkbenchs } from "../domains/workbenches/index.js";
import {
  handleApplyPackageUpdateRequest,
  handleCheckPackageUpdateRequest,
} from "./workbench-package-update-route.js";

const unusedFetcher = {
  async fetch() {
    throw new Error("unused fetcher");
  },
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-update-route-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMarsFixture(
  dir: string,
  options: { version?: string; skillBody?: string } = {},
): Promise<void> {
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await mkdir(path.join(dir, "skills", "skill-one"), { recursive: true });
  await writeFile(
    path.join(dir, "mars.toml"),
    `[package]\nname = "pkg-one"\nversion = "${options.version ?? "1.0.0"}"\ndescription = "Test package"\n\n[agents.agent-one]\nmodel = "gpt-test"\n`,
  );
  await writeFile(
    path.join(dir, "agents", "agent-one.md"),
    `---\nname: Agent One\ndescription: Test agent\nskills:\n  - skill-one\nsubagents: []\nmode: primary\n---\n\n# Agent One\n`,
  );
  await writeFile(
    path.join(dir, "skills", "skill-one", "SKILL.md"),
    `---\nname: Skill One\ndescription: Test skill\ntype: principle\n---\n\n${options.skillBody ?? "# Skill One\n"}`,
  );
}

describe("workbench package update route core", () => {
  it("update check fetches GitHub installs with the persisted ref", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { version: "1.0.0" });
      const workbenchRepo = createWorkbenchs();
      await workbenchRepo.create({ id: "workbench-1", userId: "user-1" });
      const packageRepository = createInMemoryPackageStore();
      const fetchCalls: Array<{ url: string; ref?: string }> = [];
      const fetcher = {
        async fetch(input: { url: string; ref?: string }) {
          fetchCalls.push(input);
          return fetchedMarsSourceFromDirectory(dir, "abc123");
        },
      };

      await applyPackageInstall({
        workbenchId: "workbench-1",
        source: {
          kind: "github",
          url: "https://github.com/meridian-bio/pkg-one",
          ref: "release-1",
        },
        repository: packageRepository,
        fetcher,
      });

      const install = packageRepository.dump().packages[0];
      if (!install) throw new Error("expected package install");
      expect(install.sourceRef).toBe("release-1");

      fetchCalls.length = 0;
      await writeMarsFixture(dir, { version: "1.1.0" });

      await handleCheckPackageUpdateRequest(
        { workbenchRepo, packageRepository, marsPackageFetcher: fetcher },
        {
          workbenchId: "workbench-1",
          userId: "user-1",
          installId: install.id,
        },
      );

      expect(fetchCalls).toEqual([
        { url: "https://github.com/meridian-bio/pkg-one", ref: "release-1" },
      ]);
    });
  });

  it("keeps edited skills and updates pristine ones", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { version: "1.0.0" });
      const workbenchRepo = createWorkbenchs();
      await workbenchRepo.create({ id: "workbench-1", userId: "user-1" });
      const packageRepository = createInMemoryPackageStore();

      await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: packageRepository,
        fetcher: unusedFetcher,
      });

      const install = packageRepository.dump().packages[0];
      if (!install) throw new Error("expected package install");

      const skill = packageRepository.dump().skills.find((row) => row.slug === "skill-one");
      if (!skill) throw new Error("expected skill-one");

      await packageRepository.transaction(async (tx) => {
        await tx.updateSkill(skill.id, {
          body: "Edited skill body\n",
          meta: skill.meta,
          files: skill.files,
          originalContentChecksum: skill.originalContentChecksum,
        });
      });

      await writeMarsFixture(dir, { version: "1.1.0", skillBody: "# Skill One v2\n" });

      const check = await handleCheckPackageUpdateRequest(
        { workbenchRepo, packageRepository, marsPackageFetcher: unusedFetcher },
        {
          workbenchId: "workbench-1",
          userId: "user-1",
          installId: install.id,
        },
      );

      expect(check.updateAvailable).toBe(true);
      expect(check.willKeep).toEqual([{ slug: "skill-one", kind: "skill" }]);
      expect(check.willUpdate).toEqual([{ slug: "agent-one", kind: "agent" }]);

      const applied = await handleApplyPackageUpdateRequest(
        { workbenchRepo, packageRepository, marsPackageFetcher: unusedFetcher },
        {
          workbenchId: "workbench-1",
          userId: "user-1",
          installId: install.id,
        },
      );

      expect(applied.keptSkills).toEqual(["skill-one"]);
      expect(applied.updatedAgents).toEqual(["agent-one"]);
      const keptSkill = packageRepository.dump().skills.find((row) => row.slug === "skill-one");
      expect(keptSkill?.body).toBe("Edited skill body\n");
    });
  });
});
