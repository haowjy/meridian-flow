import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isMeridianError } from "@meridian/contracts/interrupt";
import * as tar from "tar";
import { describe, expect, it } from "vitest";

import { createInMemoryPackageStore } from "../adapters/in-memory-package-store.js";
import {
  createGitHubMarsPackageFetcher,
  exportMarsPackage,
  fetchedMarsSourceFromDirectory,
  importLocalMarsPackage,
  isPackageImportError,
  parseMarsPackageSource,
  writeExportedMarsDirectory,
} from "../index.js";

const unusedMarsPackageFetcher = {
  async fetch() {
    throw new Error("unused remote package fetcher");
  },
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-mars-p2d-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMinimalPackage(
  dir: string,
  options: {
    name: string;
    visibility?: "public" | "private";
    dependencies?: string;
    extraSkillFiles?: Record<string, Buffer>;
  },
): Promise<void> {
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await mkdir(path.join(dir, "skills", "skill-one"), { recursive: true });
  await writeFile(
    path.join(dir, "mars.toml"),
    `[package]
name = "${options.name}"
version = "0.1.0"
${options.visibility ? `visibility = "${options.visibility}"\n` : ""}
${options.dependencies ?? ""}`,
  );
  await writeFile(
    path.join(dir, "agents", "agent-one.md"),
    `---
name: Agent One
description: Test agent
skills:
  - skill-one
subagents: []
mode: primary
---

# Agent One
`,
  );
  await writeFile(
    path.join(dir, "skills", "skill-one", "SKILL.md"),
    `---
name: Skill One
description: Test skill
type: reference
---

# Skill One
`,
  );
  for (const [relativePath, bytes] of Object.entries(options.extraSkillFiles ?? {})) {
    const filePath = path.join(dir, "skills", "skill-one", relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
  }
}

async function createFixtureTarball(packageDir: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const pack = tar.c({ gzip: true, cwd: packageDir, portable: true }, ["./"]);
  pack.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => {
    pack.on("end", () => resolve());
    pack.on("error", reject);
  });
  return Buffer.concat(chunks);
}

describe("P2d package source", () => {
  it("records sourceCommitSha when a url dependency is fetched from a fixture tarball", async () => {
    await withTempDir(async (dir) => {
      const depDir = path.join(dir, "dep");
      const rootDir = path.join(dir, "root");
      await writeMinimalPackage(depDir, { name: "dep-pkg" });
      const tarball = await createFixtureTarball(depDir);
      const commitSha = "abc123deadbeefcafe00feedfacecafe00feedface";

      await writeMinimalPackage(rootDir, {
        name: "root-pkg",
        dependencies: `[dependencies.dep-pkg]
url = "https://github.com/meridian-bio/dep-pkg"
version = "main"

`,
      });

      const fetcher = createGitHubMarsPackageFetcher({
        fetch: async (input) => {
          const url = String(input);
          if (url.includes("/commits/")) {
            return new Response(JSON.stringify({ sha: commitSha }), { status: 200 });
          }
          if (url.includes("codeload.github.com")) {
            return new Response(new Uint8Array(tarball), { status: 200 });
          }
          return new Response("not found", { status: 404 });
        },
      });

      const store = createInMemoryPackageStore();
      const result = await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: rootDir,
        repository: store,
        fetcher,
      });

      const depInstall = result.installedPackages.find((pkg) => pkg.packageName === "dep-pkg");
      expect(depInstall?.sourceCommitSha).toBe(commitSha);
      expect(
        result.installedPackages.find((pkg) => pkg.packageName === "root-pkg")?.sourceCommitSha,
      ).toBeNull();
    });
  });

  it("fails loudly when a url dependency cannot be resolved", async () => {
    await withTempDir(async (dir) => {
      await writeMinimalPackage(dir, {
        name: "root-pkg",
        dependencies: `[dependencies.missing]
url = "https://github.com/meridian-bio/missing"
version = "main"

`,
      });

      const store = createInMemoryPackageStore();
      await expect(
        importLocalMarsPackage({
          workbenchId: "workbench-1",
          sourceDir: dir,
          repository: store,
          fetcher: {
            async fetch() {
              throw new Error("network down");
            },
          },
        }),
      ).rejects.toSatisfy((error: unknown) => {
        if (!isPackageImportError(error)) return false;
        return (
          error.meridianError.code === "package_dependency_unresolved" &&
          error.meridianError.source === "system" &&
          isMeridianError(error.meridianError)
        );
      });
      expect(store.dump().packages).toHaveLength(0);
    });
  });

  it("round-trips binary skill files bytes-identical through import and export", async () => {
    await withTempDir(async (dir) => {
      const binary = Buffer.from([0x00, 0x48, 0x65, 0x6c, 0x80, 0xff]);
      await writeMinimalPackage(dir, {
        name: "binary-pkg",
        extraSkillFiles: { "assets/payload.bin": binary },
      });

      const store = createInMemoryPackageStore();
      await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      const exported = await exportMarsPackage({
        workbenchId: "workbench-1",
        packageName: "binary-pkg",
        repository: store,
      });
      const exportDir = path.join(dir, "exported");
      await writeExportedMarsDirectory(exported, exportDir);

      const roundTripped = await readFile(
        path.join(exportDir, "skills", "skill-one", "assets", "payload.bin"),
      );
      expect(roundTripped.equals(binary)).toBe(true);
    });
  });

  it("persists package visibility from mars.toml", async () => {
    await withTempDir(async (dir) => {
      await writeMinimalPackage(dir, { name: "visible-pkg", visibility: "public" });
      const store = createInMemoryPackageStore();

      const result = await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      expect(result.installedPackages[0]?.visibility).toBe("public");
      expect(store.dump().packages[0]?.visibility).toBe("public");
    });
  });

  it("extracts GitHub tarballs through the fetcher using injectable fetch", async () => {
    await withTempDir(async (dir) => {
      const packageDir = path.join(dir, "package");
      await writeMinimalPackage(packageDir, { name: "tarball-pkg" });
      const tarball = await createFixtureTarball(packageDir);
      const commitSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

      const fetcher = createGitHubMarsPackageFetcher({
        fetch: async (input) => {
          const url = String(input);
          if (url.includes("/commits/")) {
            return new Response(JSON.stringify({ sha: commitSha }), { status: 200 });
          }
          return new Response(new Uint8Array(tarball), { status: 200 });
        },
      });

      const fetched = await fetcher.fetch({
        url: "https://github.com/meridian-bio/tarball-pkg",
        ref: "main",
      });
      try {
        const parsed = await parseMarsPackageSource(fetched.sourceDir);
        expect(parsed.manifest.package.name).toBe("tarball-pkg");
        expect(fetched.commitSha).toBe(commitSha);
      } finally {
        await fetched.cleanup();
      }
    });
  });

  it("imports url dependencies via fetchedMarsSourceFromDirectory with commit SHA", async () => {
    await withTempDir(async (dir) => {
      const depDir = path.join(dir, "dep");
      const rootDir = path.join(dir, "root");
      await writeMinimalPackage(depDir, { name: "dep-pkg" });
      await writeMinimalPackage(rootDir, {
        name: "root-pkg",
        dependencies: `[dependencies.dep-pkg]
url = "https://github.com/meridian-bio/dep-pkg"
version = "main"

`,
      });

      const commitSha = "0123456789abcdef0123456789abcdef01234567";
      const store = createInMemoryPackageStore();
      const result = await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: rootDir,
        repository: store,
        fetcher: {
          async fetch() {
            return fetchedMarsSourceFromDirectory(depDir, commitSha);
          },
        },
      });

      expect(result.installedPackages.map((pkg) => pkg.packageName)).toEqual([
        "dep-pkg",
        "root-pkg",
      ]);
      expect(result.installedPackages[0]?.sourceCommitSha).toBe(commitSha);
    });
  });
});
