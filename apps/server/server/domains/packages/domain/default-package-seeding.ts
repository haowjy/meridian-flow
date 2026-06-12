// @ts-nocheck
/**
 * Purpose: Imports the configured default Mars packages into a workbench and
 * keeps already-installed package records reconciled with source changes.
 * Key decision: defaults are code-seeded from local package directories; the
 * repository checksum/update logic is the idempotence boundary, so startup and
 * first-touch callers can safely invoke this repeatedly.
 */
import path from "node:path";
import type { MarsPackageFetcher } from "../ports/mars-package-fetcher.js";
import type { PackageRepository } from "../ports/package-store.js";
import { importLocalMarsPackage, updateLocalMarsPackage } from "./package-sync.js";
import type { PackageImportResult, PackageUpdateResult } from "./types.js";

export interface DefaultPackageSeedConfig {
  /** Absolute or process-cwd-relative Mars package directories. */
  packageDirs: string[];
}

export interface DefaultPackageSeedResult {
  sourceDir: string;
  action: "imported" | "updated";
  result: PackageImportResult | PackageUpdateResult;
}

export interface DefaultPackageSeeder {
  seedWorkbench(workbenchId: string): Promise<DefaultPackageSeedResult[]>;
}

export function defaultPackageSeedConfigFromEnv(env: {
  DEFAULT_PACKAGE_DIRS?: string;
}): DefaultPackageSeedConfig {
  return {
    packageDirs: (env.DEFAULT_PACKAGE_DIRS ?? "")
      .split(/[,;]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  };
}

export function createDefaultPackageSeeder(input: {
  repository: PackageRepository;
  fetcher: MarsPackageFetcher;
  config: DefaultPackageSeedConfig;
}): DefaultPackageSeeder {
  const packageDirs = input.config.packageDirs.map((dir) => path.resolve(dir));
  return {
    async seedWorkbench(workbenchId) {
      const results: DefaultPackageSeedResult[] = [];
      for (const sourceDir of packageDirs) {
        const imported = await importLocalMarsPackage({
          workbenchId,
          sourceDir,
          repository: input.repository,
          fetcher: input.fetcher,
        });
        if (imported.installedPackages.length > 0) {
          results.push({ sourceDir, action: "imported", result: imported });
          continue;
        }

        // Existing package: reconcile pristine records. This keeps repeated
        // seeding cheap and content-sensitive without supporting compatibility
        // aliases for stale package definitions.
        results.push({
          sourceDir,
          action: "updated",
          result: await updateLocalMarsPackage({
            workbenchId,
            sourceDir,
            repository: input.repository,
          }),
        });
      }
      return results;
    },
  };
}
