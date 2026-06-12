// @ts-nocheck
// PackageRepository conformance suite: shared behavioral contract for all package stores.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { definitionContentChecksum } from "../../domain/mars-source.js";
import { importLocalMarsPackage, updateLocalMarsPackage } from "../../domain/package-sync.js";
import type { PackageRepository } from "../../ports/package-store.js";

export interface PackageRepositoryConformanceFixtures {
  workbenchId: string;
  userId: string;
}

const DEFAULT_FIXTURES: PackageRepositoryConformanceFixtures = {
  workbenchId: "workbench-1",
  userId: "user-1",
};

export function describePackageRepositoryConformance(
  name: string,
  makeRepo: () => PackageRepository | Promise<PackageRepository>,
  fixtures: PackageRepositoryConformanceFixtures = DEFAULT_FIXTURES,
): void {
  const unusedMarsPackageFetcher = {
    async fetch() {
      throw new Error("unused remote package fetcher");
    },
  };

  describe(`PackageRepository conformance: ${name}`, () => {
    it("findPackageInstall returns undefined when missing and the row after create", async () => {
      const repo = await makeRepo();

      expect(await repo.findPackageInstall(fixtures.workbenchId, "pkg-a")).toBeUndefined();

      await repo.transaction(async (tx) => {
        await tx.createPackageInstall({
          workbenchId: fixtures.workbenchId,
          sourcePath: "/tmp/pkg-a",
          packageName: "pkg-a",
          version: "1.0.0",
          visibility: "private",
        });
      });

      const install = await repo.findPackageInstall(fixtures.workbenchId, "pkg-a");
      expect(install).toMatchObject({
        workbenchId: fixtures.workbenchId,
        packageName: "pkg-a",
        version: "1.0.0",
      });
    });

    it("commits transaction writes so they are visible after the callback", async () => {
      const repo = await makeRepo();
      let installId = "";

      await repo.transaction(async (tx) => {
        const install = await tx.createPackageInstall({
          workbenchId: fixtures.workbenchId,
          sourcePath: "/tmp/pkg-b",
          packageName: "pkg-b",
          visibility: "private",
        });
        installId = install.id;

        const agent = await tx.createAgentDefinition({
          workbenchId: fixtures.workbenchId,
          slug: "agent-b",
          body: "# Agent",
          meta: { name: "Agent B" },
          config: {},
          packageInstallId: install.id,
          originalContentChecksum: null,
          sourceType: "package",
          enabled: true,
        });

        const skill = await tx.createSkill({
          workbenchId: fixtures.workbenchId,
          slug: "skill-b",
          body: "# Skill",
          meta: { name: "Skill B", type: "reference" },
          files: {},
          packageInstallId: install.id,
          originalContentChecksum: null,
          sourceType: "package",
          enabled: true,
        });

        await tx.linkAgentSkill({
          agentDefinitionId: agent.id,
          skillId: skill.id,
        });

        expect(await tx.findPackageInstall(fixtures.workbenchId, "pkg-b")).toBeDefined();
      });

      expect(await repo.findPackageInstall(fixtures.workbenchId, "pkg-b")).toMatchObject({
        id: installId,
        packageName: "pkg-b",
      });
    });

    it("getAgentWithLinkedSkills resolves global, builtin, and agent-linked skills", async () => {
      const repo = await makeRepo();

      await repo.transaction(async (tx) => {
        const agent = await tx.createAgentDefinition({
          workbenchId: fixtures.workbenchId,
          slug: "agent-one",
          body: "",
          meta: { name: "agent-one" },
          config: {},
          packageInstallId: null,
          originalContentChecksum: null,
          sourceType: "package",
          enabled: true,
        });

        await tx.createSkill(skillInput("builtin-skill", null, { type: "reference" }));
        await tx.createSkill(
          skillInput("global-skill", fixtures.workbenchId, { type: "principle", isGlobal: true }),
        );
        const linked = await tx.createSkill(
          skillInput("linked-skill", fixtures.workbenchId, { type: "reference" }),
        );
        await tx.linkAgentSkill({
          agentDefinitionId: agent.id,
          skillId: linked.id,
        });
      });

      const resolved = await repo.getAgentWithLinkedSkills(
        fixtures.workbenchId,
        fixtures.userId,
        "agent-one",
      );

      expect(resolved.agent?.slug).toBe("agent-one");
      expect(resolved.skills.map((entry) => entry.skill.slug)).toEqual([
        "global-skill",
        "builtin-skill",
        "linked-skill",
      ]);
      expect(resolved.skills.find((entry) => entry.skill.slug === "linked-skill")?.layer).toBe(
        "workbench",
      );
    });

    it("listSelectableAgents excludes subagents after Mars import", async () => {
      const repo = await makeRepo();

      await withTempMarsPackage(async (sourceDir) => {
        await writeMarsPackage(sourceDir, {
          packageName: "pkg-subagent-filter",
          agents: {
            "agent-one": {
              skills: [],
              subagents: ["agent-two"],
              mode: "primary",
            },
            "agent-two": {
              skills: [],
              subagents: [],
              mode: "subagent",
            },
          },
          skills: [],
        });
        await importLocalMarsPackage({
          workbenchId: fixtures.workbenchId,
          sourceDir,
          repository: repo,
          fetcher: unusedMarsPackageFetcher,
        });
      });

      const selectable = await repo.transaction((tx) =>
        tx.listSelectableAgents(fixtures.workbenchId),
      );
      expect(selectable.map((agent) => agent.slug)).toEqual(["agent-one"]);
    });

    it("deduplicates repeated package-authored skill and subagent links", async () => {
      const repo = await makeRepo();

      await withTempMarsPackage(async (sourceDir) => {
        await writeMarsPackage(sourceDir, {
          packageName: "pkg-duplicate-links",
          agents: {
            "agent-one": {
              skills: ["skill-one"],
              subagents: ["agent-two"],
              mode: "primary",
            },
            "agent-two": {
              skills: [],
              subagents: [],
              mode: "subagent",
            },
          },
          skills: ["skill-one"],
        });
        await importLocalMarsPackage({
          workbenchId: fixtures.workbenchId,
          sourceDir,
          repository: repo,
          fetcher: unusedMarsPackageFetcher,
        });

        await writeMarsPackage(sourceDir, {
          packageName: "pkg-duplicate-links",
          agents: {
            "agent-one": {
              skills: ["skill-one", "skill-one"],
              subagents: ["agent-two", "agent-two"],
              mode: "primary",
            },
            "agent-two": {
              skills: [],
              subagents: [],
              mode: "subagent",
            },
          },
          skills: ["skill-one"],
        });

        await expect(
          updateLocalMarsPackage({
            workbenchId: fixtures.workbenchId,
            sourceDir,
            repository: repo,
            forceReset: true,
          }),
        ).resolves.toMatchObject({
          updatedAgents: ["agent-one", "agent-two"],
          updatedSkills: ["skill-one"],
        });
      });

      const resolved = await repo.getAgentWithLinkedSkills(
        fixtures.workbenchId,
        fixtures.userId,
        "agent-one",
      );
      expect(resolved.skills.map((entry) => entry.skill.slug)).toEqual(["skill-one"]);
    });

    it("preserves authored order for same-type linked skills", async () => {
      const repo = await makeRepo();

      await withTempMarsPackage(async (sourceDir) => {
        await writeMarsPackage(sourceDir, {
          packageName: "pkg-linked-order",
          agents: {
            "agent-one": {
              skills: ["skill-two", "skill-one"],
              subagents: [],
              mode: "primary",
            },
          },
          skills: ["skill-one", "skill-two"],
          skillType: "reference",
        });

        await importLocalMarsPackage({
          workbenchId: fixtures.workbenchId,
          sourceDir,
          repository: repo,
          fetcher: unusedMarsPackageFetcher,
        });
      });

      const resolved = await repo.getAgentWithLinkedSkills(
        fixtures.workbenchId,
        fixtures.userId,
        "agent-one",
      );
      expect(resolved.skills.map((entry) => entry.skill.slug)).toEqual(["skill-two", "skill-one"]);
    });
  });
}

function skillInput(slug: string, workbenchId: string | null, meta: Record<string, unknown>) {
  const body = "";
  const fullMeta = {
    name: slug,
    modelInvocable: true,
    userInvocable: true,
    isGlobal: false,
    ...meta,
  };
  return {
    workbenchId,
    slug,
    body,
    meta: fullMeta,
    files: {},
    packageInstallId: null,
    originalContentChecksum: definitionContentChecksum({ body, meta: fullMeta, files: {} }),
    sourceType: (workbenchId ? "package" : "builtin") as "package" | "builtin",
    enabled: true,
  };
}

async function withTempMarsPackage<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-package-conformance-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMarsPackage(
  dir: string,
  options: {
    packageName: string;
    agents: Record<
      string,
      {
        skills: string[];
        subagents: string[];
        mode: "primary" | "subagent";
      }
    >;
    skills: string[];
    skillType?: "principle" | "guardrail" | "reference";
  },
): Promise<void> {
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await mkdir(path.join(dir, "skills"), { recursive: true });
  await writeFile(
    path.join(dir, "mars.toml"),
    `[package]\nname = "${options.packageName}"\nversion = "1.0.0"\n`,
  );

  for (const [slug, agent] of Object.entries(options.agents)) {
    await writeFile(
      path.join(dir, "agents", `${slug}.md`),
      `---
name: ${slug}
description: ${slug}
skills:
${yamlList(agent.skills)}
subagents:
${yamlList(agent.subagents)}
mode: ${agent.mode}
---

# ${slug}
`,
    );
  }

  for (const slug of options.skills) {
    const skillDir = path.join(dir, "skills", slug);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: ${slug}
description: ${slug}
type: ${options.skillType ?? "reference"}
model-invocable: true
user-invocable: true
is-global: false
---

# ${slug}
`,
    );
  }
}

function yamlList(values: string[]): string {
  if (values.length === 0) return "  []";
  return values.map((value) => `  - ${value}`).join("\n");
}
