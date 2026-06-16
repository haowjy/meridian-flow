/**
 * Purpose: Imports the configured default Mars packages into a project and
 * keeps already-installed package records reconciled with source changes.
 * Key decision: defaults are code-seeded from local package directories; the
 * repository checksum/update logic is the idempotence boundary, so startup and
 * first-touch callers can safely invoke this repeatedly.
 */

import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MarsPackageFetcher } from "../ports/mars-package-fetcher.js";
import type { PackageRepository } from "../ports/package-store.js";
import { importLocalMarsPackage, updateLocalMarsPackage } from "./package-sync.js";
import type { PackageImportResult, PackageUpdateResult } from "./types.js";

export interface DefaultPackageSeedConfig {
  /** Absolute or process-cwd-relative Mars package directories. */
  packageDirs: string[];
}

const LAUNCH_AGENT_PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../builtin/launch-agents",
);
const BUILTIN_LAUNCH_AGENT_ASSET_PREFIX = "builtin/launch-agents/";
const SOURCE_LAUNCH_AGENT_PACKAGE_RELATIVE_PATH =
  "apps/server/server/domains/packages/builtin/launch-agents";
let materializedLaunchAgentPackageDir: Promise<string> | null = null;

export interface DefaultPackageSeedResult {
  sourceDir: string;
  action: "imported" | "updated";
  result: PackageImportResult | PackageUpdateResult;
}

export interface DefaultPackageSeeder {
  seedProject(projectId: string): Promise<DefaultPackageSeedResult[]>;
}

export function defaultPackageSeedConfigFromEnv(env: {
  DEFAULT_PACKAGE_DIRS?: string;
}): DefaultPackageSeedConfig {
  return {
    packageDirs: [
      LAUNCH_AGENT_PACKAGE_DIR,
      ...(env.DEFAULT_PACKAGE_DIRS ?? "")
        .split(/[,;]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ],
  };
}

export async function resolveLaunchAgentPackageDir(): Promise<string> {
  return resolvePackageSourceDir(LAUNCH_AGENT_PACKAGE_DIR);
}

export function createDefaultPackageSeeder(input: {
  repository: PackageRepository;
  fetcher: MarsPackageFetcher;
  config: DefaultPackageSeedConfig;
}): DefaultPackageSeeder {
  const packageDirs = input.config.packageDirs.map((dir) => path.resolve(dir));
  return {
    async seedProject(projectId) {
      const results: DefaultPackageSeedResult[] = [];
      for (const sourceDir of packageDirs) {
        const resolvedSourceDir = await resolvePackageSourceDir(sourceDir);
        const imported = await importLocalMarsPackage({
          projectId,
          sourceDir: resolvedSourceDir,
          repository: input.repository,
          fetcher: input.fetcher,
        });
        if (imported.installedPackages.length > 0) {
          results.push({ sourceDir: resolvedSourceDir, action: "imported", result: imported });
          continue;
        }

        // Existing package: reconcile pristine records. This keeps repeated
        // seeding cheap and content-sensitive without supporting compatibility
        // aliases for stale package definitions.
        results.push({
          sourceDir: resolvedSourceDir,
          action: "updated",
          result: await updateLocalMarsPackage({
            projectId,
            sourceDir: resolvedSourceDir,
            repository: input.repository,
          }),
        });
      }
      return results;
    },
  };
}

async function resolvePackageSourceDir(sourceDir: string): Promise<string> {
  try {
    await access(path.join(sourceDir, "mars.toml"));
    return sourceDir;
  } catch (error) {
    if (path.normalize(sourceDir) !== path.normalize(LAUNCH_AGENT_PACKAGE_DIR)) throw error;
    const sourceFallback = await firstExistingPackageDir(launchAgentPackageDirCandidates());
    if (sourceFallback) return sourceFallback;
    materializedLaunchAgentPackageDir ??= materializeLaunchAgentPackageFromNitroAssets();
    return materializedLaunchAgentPackageDir;
  }
}

async function firstExistingPackageDir(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "mars.toml"));
      return candidate;
    } catch {
      // Try the next source-relative fallback.
    }
  }
  return null;
}

function launchAgentPackageDirCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDir, "../../../server/domains/packages/builtin/launch-agents"),
    path.resolve(moduleDir, "../../../../", SOURCE_LAUNCH_AGENT_PACKAGE_RELATIVE_PATH),
    ...(process.env.MERIDIAN_TASK_DIR
      ? [path.join(process.env.MERIDIAN_TASK_DIR, SOURCE_LAUNCH_AGENT_PACKAGE_RELATIVE_PATH)]
      : []),
    path.resolve(process.cwd(), "server/domains/packages/builtin/launch-agents"),
    path.resolve(process.cwd(), SOURCE_LAUNCH_AGENT_PACKAGE_RELATIVE_PATH),
  ];
}

async function materializeLaunchAgentPackageFromNitroAssets(): Promise<string> {
  const serverAssets = await import(/* @vite-ignore */ "#nitro/virtual/server-assets");
  const root = await mkdtemp(path.join(tmpdir(), "meridian-launch-agents-"));
  const packageDir = path.join(root, "launch-agents");
  const keys = (await serverAssets.assets.getKeys()).filter((key: string) =>
    key.startsWith(BUILTIN_LAUNCH_AGENT_ASSET_PREFIX),
  );
  for (const key of keys) {
    const relative = key.slice(BUILTIN_LAUNCH_AGENT_ASSET_PREFIX.length);
    const target = path.join(packageDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await serverAssets.assets.getItem(key), "utf8");
  }
  return packageDir;
}
