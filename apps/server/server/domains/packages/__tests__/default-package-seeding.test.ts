/**
 * Purpose: Verifies code-seeded default Mars packages stay idempotent while
 * still reconciling source changes through the package update path.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createInMemoryPackageStore } from "../adapters/in-memory-package-store.js";
import { createDefaultPackageSeeder } from "../domain/default-package-seeding.js";

const unusedMarsPackageFetcher = {
  async fetch() {
    throw new Error("unused remote package fetcher");
  },
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-default-package-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writePackage(dir: string, skillBody: string): Promise<void> {
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await mkdir(path.join(dir, "skills", "skill-one"), { recursive: true });
  await writeFile(
    path.join(dir, "mars.toml"),
    `[package]\nname = "default-pilot"\nversion = "0.1.0"\n`,
  );
  await writeFile(
    path.join(dir, "agents", "agent-one.md"),
    "---\nskills:\n  - skill-one\n---\n\nAgent body\n",
  );
  await writeFile(path.join(dir, "skills", "skill-one", "SKILL.md"), skillBody);
}

describe("createDefaultPackageSeeder", () => {
  it("imports once and reconciles changed pristine records on repeated seeding", async () => {
    await withTempDir(async (dir) => {
      await writePackage(dir, "---\nmodel-invocable: true\n---\n\nfirst\n");
      const store = createInMemoryPackageStore();
      const seeder = createDefaultPackageSeeder({
        repository: store,
        fetcher: unusedMarsPackageFetcher,
        config: { packageDirs: [dir] },
      });

      const first = await seeder.seedProject("project-1");
      expect(first).toMatchObject([{ action: "imported" }]);

      const second = await seeder.seedProject("project-1");
      expect(second).toMatchObject([{ action: "updated" }]);

      await writePackage(dir, "---\nmodel-invocable: true\n---\n\nsecond\n");
      const third = await seeder.seedProject("project-1");
      expect(third[0]?.result).toMatchObject({ updatedSkills: ["skill-one"] });

      const resolved = await store.getAgentWithLinkedSkills("project-1", "user-1", "agent-one");
      expect(resolved.skills[0]?.skill.body).toBe("second\n");
    });
  });
});
