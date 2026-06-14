// @ts-nocheck
/** Route-core tests for package install preview/apply and preview truthfulness. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  createInMemoryPackageStore,
  importLocalMarsPackage,
  updateLocalMarsPackage,
} from "../domains/packages/index.js";
import { fetchedMarsSourceFromDirectory } from "../domains/packages/ports/mars-package-fetcher.js";
import { createInMemoryProjectRepository as createProjects } from "../domains/projects/index.js";
import {
  handleApplyPackageInstallRequest,
  handlePreviewPackageInstallRequest,
} from "./project-package-install-route.js";

const unusedFetcher = {
  async fetch() {
    throw new Error("unused fetcher");
  },
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-install-route-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMarsFixture(dir: string, name = "pkg-one"): Promise<void> {
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await mkdir(path.join(dir, "skills", "skill-one"), { recursive: true });
  await writeFile(
    path.join(dir, "mars.toml"),
    `[package]\nname = "${name}"\nversion = "1.0.0"\ndescription = "Test package"\n\n[agents.agent-one]\nmodel = "gpt-test"\n`,
  );
  await writeFile(
    path.join(dir, "agents", "agent-one.md"),
    `---\nname: Agent One\ndescription: Test agent\nskills:\n  - skill-one\nsubagents: []\nmode: primary\n---\n\n# Agent One\n`,
  );
  await writeFile(
    path.join(dir, "skills", "skill-one", "SKILL.md"),
    `---\nname: Skill One\ndescription: Test skill\ntype: principle\n---\n\n# Skill One\n`,
  );
}

describe("project package install route core", () => {
  it("preview collisions match apply skip-and-keep semantics for slug collisions", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir);
      await writeFile(path.join(dir, "BOOTSTRAP.md"), "# Setup\n");
      const projectRepo = createProjects();
      await projectRepo.create({ id: "project-1", userId: "user-1" });
      const packageRepository = createInMemoryPackageStore({
        skills: [
          {
            id: "skill-existing",
            projectId: "project-1",
            slug: "skill-one",
            body: "Existing body",
            meta: { name: "Skill One", description: "Existing" },
            files: {},
            packageInstallId: null,
            originalContentChecksum: null,
            sourceType: "user",
            enabled: true,
          },
        ],
      });
      const fetcher = {
        async fetch() {
          return fetchedMarsSourceFromDirectory(dir, "abc123");
        },
      };

      const preview = await handlePreviewPackageInstallRequest(
        { projectRepo, packageRepository, marsPackageFetcher: fetcher },
        {
          projectId: "project-1",
          userId: "user-1",
          source: { kind: "github", url: "https://github.com/meridian-bio/pkg-one" },
        },
      );

      expect(preview.collisions).toEqual([
        { slug: "skill-one", kind: "skill", action: "keep_existing" },
      ]);
      expect(preview.skills.map((skill) => skill.slug)).toEqual([]);
      expect(preview.agents.map((agent) => agent.slug)).toEqual(["agent-one"]);
      expect(preview.includesSetupInstructions).toBe(true);

      const applied = await handleApplyPackageInstallRequest(
        { projectRepo, packageRepository, marsPackageFetcher: fetcher },
        {
          projectId: "project-1",
          userId: "user-1",
          source: { kind: "github", url: "https://github.com/meridian-bio/pkg-one" },
        },
      );

      expect(applied.skippedSkills).toEqual(["skill-one"]);
      expect(applied.insertedSkills).toEqual([]);
      expect(applied.insertedAgents).toEqual(["agent-one"]);
    });
  });

  it("preview collisions match apply for retired (disabled) slug occupants", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir);
      await writeFile(
        path.join(dir, "agents", "agent-two.md"),
        `---\nname: Agent Two\ndescription: Retired subagent\nskills: []\nsubagents: []\nmode: subagent\n---\n\n# Agent Two\n`,
      );
      const projectRepo = createProjects();
      await projectRepo.create({ id: "project-1", userId: "user-1" });
      const packageRepository = createInMemoryPackageStore();
      const fetcher = {
        async fetch() {
          return fetchedMarsSourceFromDirectory(dir, "abc123");
        },
      };

      await importLocalMarsPackage({
        projectId: "project-1",
        sourceDir: dir,
        repository: packageRepository,
        fetcher,
      });

      await packageRepository.transaction(async (tx) => {
        const agent = await tx.findAgentDefinition("project-1", "agent-two");
        if (!agent?.originalContentChecksum) throw new Error("missing agent-two");
        await tx.appendAgentDefinitionRevision({
          agentDefinitionId: agent.id,
          contentChecksum: agent.originalContentChecksum,
          body: agent.body,
          meta: agent.meta,
          config: agent.config,
        });
      });

      await rm(path.join(dir, "agents", "agent-two.md"), { force: true });
      await updateLocalMarsPackage({
        projectId: "project-1",
        sourceDir: dir,
        repository: packageRepository,
      });

      const retired = packageRepository.dump().agents.find((agent) => agent.slug === "agent-two");
      expect(retired?.enabled).toBe(false);

      const secondDir = path.join(dir, "pkg-two");
      await mkdir(secondDir, { recursive: true });
      await mkdir(path.join(secondDir, "agents"), { recursive: true });
      await writeFile(
        path.join(secondDir, "mars.toml"),
        `[package]\nname = "pkg-two"\nversion = "1.0.0"\n`,
      );
      await writeFile(
        path.join(secondDir, "agents", "agent-two.md"),
        `---\nname: Agent Two\ndescription: Colliding agent\nskills: []\nsubagents: []\nmode: primary\n---\n\n# Agent Two\n`,
      );
      const secondFetcher = {
        async fetch() {
          return fetchedMarsSourceFromDirectory(secondDir, "def456");
        },
      };

      const preview = await handlePreviewPackageInstallRequest(
        { projectRepo, packageRepository, marsPackageFetcher: secondFetcher },
        {
          projectId: "project-1",
          userId: "user-1",
          source: { kind: "github", url: "https://github.com/meridian-bio/pkg-two" },
        },
      );

      expect(preview.collisions).toEqual([
        { slug: "agent-two", kind: "agent", action: "keep_existing" },
      ]);
      expect(preview.agents.map((agent) => agent.slug)).toEqual([]);

      const applied = await handleApplyPackageInstallRequest(
        { projectRepo, packageRepository, marsPackageFetcher: secondFetcher },
        {
          projectId: "project-1",
          userId: "user-1",
          source: { kind: "github", url: "https://github.com/meridian-bio/pkg-two" },
        },
      );

      expect(applied.skippedAgents).toEqual(["agent-two"]);
      expect(applied.insertedAgents).toEqual([]);
      expect(retired?.enabled).toBe(false);
    });
  });

  it("rejects catalog install when the entry has no source URL yet", async () => {
    const projectRepo = createProjects();
    await projectRepo.create({ id: "project-1", userId: "user-1" });
    const packageRepository = createInMemoryPackageStore();

    await expect(
      handlePreviewPackageInstallRequest(
        { projectRepo, packageRepository, marsPackageFetcher: unusedFetcher },
        {
          projectId: "project-1",
          userId: "user-1",
          source: { kind: "catalog", catalogId: "literature-review" },
        },
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
