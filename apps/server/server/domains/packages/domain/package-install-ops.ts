// @ts-nocheck
/**
 * Package install/update orchestration: resolves GitHub and catalog sources,
 * coordinates fetch cleanup, and maps domain results to contract shapes.
 */
import { access } from "node:fs/promises";

import type {
  PackageInstallApplyResponse,
  PackageInstallPreviewResponse,
  PackageInstallSource,
  PackageUpdateApplyResponse,
  PackageUpdateCheckResponse,
} from "@meridian/contracts/agents";
import { createError } from "nitro/h3";
import { parseGitHubRepoUrl } from "../adapters/github-mars-package-fetcher.js";
import type { MarsPackageFetcher } from "../ports/mars-package-fetcher.js";
import type { PackageRepository } from "../ports/package-store.js";
import { resolveCatalogSource } from "./first-party-catalog.js";
import { isNodeError } from "./helpers.js";
import { isPackageImportError } from "./package-import-error.js";
import {
  importLocalMarsPackage,
  previewLocalMarsPackageImport,
  previewLocalMarsPackageUpdate,
  updateLocalMarsPackage,
} from "./package-sync.js";
import type { PackageImportResult, PackageInstallRecord, PackageUpdateResult } from "./types.js";

interface ResolvedMarsSource {
  sourceDir: string;
  sourceCommitSha: string | null;
  sourcePathOverride?: string;
  sourceRef?: string | null;
  cleanup: () => Promise<void>;
}

export async function resolvePackageInstallSource(input: {
  source: PackageInstallSource;
  fetcher: MarsPackageFetcher;
}): Promise<ResolvedMarsSource> {
  if (input.source.kind === "catalog") {
    const resolved = resolveCatalogSource(input.source.catalogId);
    if (!resolved) {
      throw createError({
        statusCode: 422,
        message: `Catalog package "${input.source.catalogId}" is not available for install yet`,
      });
    }
    return resolveGitHubMarsSource({
      url: resolved.url,
      ref: resolved.ref,
      fetcher: input.fetcher,
    });
  }

  return resolveGitHubMarsSource({
    url: input.source.url,
    ref: input.source.ref,
    fetcher: input.fetcher,
  });
}

async function resolveGitHubMarsSource(input: {
  url: string;
  ref?: string;
  fetcher: MarsPackageFetcher;
}): Promise<ResolvedMarsSource> {
  parseGitHubRepoUrl(input.url);
  const ref = input.ref?.trim() || "main";
  const fetched = await input.fetcher.fetch({ url: input.url, ref });
  return {
    sourceDir: fetched.sourceDir,
    sourceCommitSha: fetched.commitSha,
    sourcePathOverride: input.url,
    sourceRef: ref,
    cleanup: fetched.cleanup,
  };
}

export async function previewPackageInstall(input: {
  workbenchId: string;
  source: PackageInstallSource;
  repository: PackageRepository;
  fetcher: MarsPackageFetcher;
}): Promise<PackageInstallPreviewResponse> {
  const resolved = await resolvePackageInstallSource({
    source: input.source,
    fetcher: input.fetcher,
  });
  try {
    return await previewLocalMarsPackageImport({
      workbenchId: input.workbenchId,
      sourceDir: resolved.sourceDir,
      repository: input.repository,
      fetcher: input.fetcher,
      sourceCommitSha: resolved.sourceCommitSha,
    });
  } catch (error) {
    throw toPackageRouteError(error);
  } finally {
    await resolved.cleanup();
  }
}

export async function applyPackageInstall(input: {
  workbenchId: string;
  source: PackageInstallSource;
  repository: PackageRepository;
  fetcher: MarsPackageFetcher;
}): Promise<PackageInstallApplyResponse> {
  const resolved = await resolvePackageInstallSource({
    source: input.source,
    fetcher: input.fetcher,
  });
  try {
    const result = await importLocalMarsPackage({
      workbenchId: input.workbenchId,
      sourceDir: resolved.sourceDir,
      repository: input.repository,
      fetcher: input.fetcher,
      sourceCommitSha: resolved.sourceCommitSha,
      sourcePathOverride: resolved.sourcePathOverride,
      sourceRef: resolved.sourceRef,
    });
    return mapImportResult(result);
  } catch (error) {
    throw toPackageRouteError(error);
  } finally {
    await resolved.cleanup();
  }
}

export async function checkPackageUpdate(input: {
  workbenchId: string;
  installId: string;
  repository: PackageRepository;
  fetcher: MarsPackageFetcher;
}): Promise<PackageUpdateCheckResponse> {
  const install = await findOwnedPackageInstall(
    input.repository,
    input.workbenchId,
    input.installId,
  );
  const resolved = await resolveUpdateSource(install, input.fetcher);
  try {
    const preview = await previewLocalMarsPackageUpdate({
      workbenchId: input.workbenchId,
      sourceDir: resolved.sourceDir,
      repository: input.repository,
      packageInstallId: install.id,
      upstreamCommitSha: resolved.sourceCommitSha,
    });
    return {
      installId: install.id,
      packageName: preview.packageName,
      currentVersion: preview.currentVersion,
      upstreamVersion: preview.upstreamVersion,
      upstreamCommitSha: preview.upstreamCommitSha,
      willUpdate: preview.willUpdate,
      willKeep: preview.willKeep,
      willRemove: preview.willRemove,
      willRetire: preview.willRetire,
      updateAvailable: preview.updateAvailable,
    };
  } catch (error) {
    throw toPackageRouteError(error);
  } finally {
    await resolved.cleanup();
  }
}

export async function applyPackageUpdate(input: {
  workbenchId: string;
  installId: string;
  repository: PackageRepository;
  fetcher: MarsPackageFetcher;
}): Promise<PackageUpdateApplyResponse> {
  const install = await findOwnedPackageInstall(
    input.repository,
    input.workbenchId,
    input.installId,
  );
  const resolved = await resolveUpdateSource(install, input.fetcher);
  try {
    const result = await updateLocalMarsPackage({
      workbenchId: input.workbenchId,
      sourceDir: resolved.sourceDir,
      repository: input.repository,
    });
    return mapUpdateResult(install.id, result);
  } catch (error) {
    throw toPackageRouteError(error);
  } finally {
    await resolved.cleanup();
  }
}

export async function findOwnedPackageInstall(
  repository: PackageRepository,
  workbenchId: string,
  installId: string,
): Promise<PackageInstallRecord> {
  const install = await repository.transaction(async (tx) => {
    const rows = await tx.listPackageInstalls(workbenchId);
    return rows.find((row) => row.id === installId);
  });
  if (!install) {
    throw createError({ statusCode: 404, message: "Package install not found" });
  }
  return install;
}

async function resolveUpdateSource(
  install: PackageInstallRecord,
  fetcher: MarsPackageFetcher,
): Promise<ResolvedMarsSource> {
  if (install.sourcePath?.startsWith("https://github.com/")) {
    const ref = install.sourceRef?.trim() || "main";
    const fetched = await fetcher.fetch({ url: install.sourcePath, ref });
    return {
      sourceDir: fetched.sourceDir,
      sourceCommitSha: fetched.commitSha,
      sourceRef: ref,
      cleanup: fetched.cleanup,
    };
  }

  if (install.sourcePath) {
    try {
      await access(install.sourcePath);
      return {
        sourceDir: install.sourcePath,
        sourceCommitSha: install.sourceCommitSha ?? null,
        cleanup: async () => undefined,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw createError({
          statusCode: 422,
          message: `Package source path is no longer available: ${install.sourcePath}`,
        });
      }
      throw error;
    }
  }

  throw createError({
    statusCode: 422,
    message: "Package install has no resolvable source for update",
  });
}

function mapImportResult(result: PackageImportResult): PackageInstallApplyResponse {
  return {
    installedPackages: result.installedPackages.map((pkg) => ({
      id: pkg.id,
      packageName: pkg.packageName,
      version: pkg.version ?? null,
    })),
    skippedPackages: result.skippedPackages,
    insertedAgents: result.insertedAgents.map((agent) => agent.slug),
    insertedSkills: result.insertedSkills.map((skill) => skill.slug),
    skippedAgents: result.skippedAgents,
    skippedSkills: result.skippedSkills,
  };
}

function mapUpdateResult(
  installId: string,
  result: PackageUpdateResult,
): PackageUpdateApplyResponse {
  return {
    installId,
    packageName: result.packageInstall?.packageName ?? "",
    version: result.packageInstall?.version ?? null,
    updatedAgents: result.updatedAgents,
    updatedSkills: result.updatedSkills,
    keptAgents: result.skippedAgents,
    keptSkills: result.skippedSkills,
    removedAgents: result.removedAgents,
    removedSkills: result.removedSkills,
    retiredAgents: result.retiredAgents,
    retiredSkills: result.retiredSkills,
  };
}

function toPackageRouteError(error: unknown): Error {
  if (isPackageImportError(error)) {
    throw createError({ statusCode: 422, message: error.message });
  }
  if (error instanceof Error && error.message.includes("GitHub")) {
    throw createError({ statusCode: 422, message: error.message });
  }
  throw error;
}
