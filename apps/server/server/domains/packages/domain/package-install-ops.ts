/** Fetch orchestration for account-owned package source publication. */
import path from "node:path";
import type { PackageInstallSource, PackageUpdateApplyResponse } from "@meridian/contracts/agents";
import { createError } from "nitro/h3";
import { parseGitHubRepoUrl } from "../adapters/github-mars-package-fetcher.js";
import type {
  AgentPackageInstallation,
  AgentRevisionStore,
} from "../ports/agent-revision-store.js";
import type { MarsPackageFetcher } from "../ports/mars-package-fetcher.js";
import { AgentConfigurationError } from "./agent-configuration.js";
import { AgentSourceError } from "./agent-source-revision.js";
import { resolveCatalogSource } from "./first-party-catalog.js";
import {
  findOwnedInstallation,
  importPackageGraph,
  PackageInstallationNotFoundError,
  previewPackageGraph,
  updatePackageGraph,
} from "./package-management.js";
import { readPackageGraph } from "./package-source.js";
import { AgentPublicationConflictError } from "./source-publication.js";

interface ResolvedMarsSource {
  kind: "local" | "downloaded";
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
  const repo = parseGitHubRepoUrl(input.url);
  const ref = input.ref?.trim() || "main";
  const fetched = await input.fetcher.fetch({ url: input.url, ref });
  return {
    kind: "downloaded",
    sourceDir: fetched.sourceDir,
    sourceCommitSha: fetched.commitSha,
    sourcePathOverride: `https://github.com/${repo.owner}/${repo.repo}`,
    sourceRef: ref,
    cleanup: fetched.cleanup,
  };
}

type InstallInput = {
  userId: string;
  source: PackageInstallSource;
  store: AgentRevisionStore;
  fetcher: MarsPackageFetcher;
};
type UpdateInput = {
  userId: string;
  installId: string;
  store: AgentRevisionStore;
  fetcher: MarsPackageFetcher;
};
async function withSource<T>(
  resolved: ResolvedMarsSource,
  fetcher: MarsPackageFetcher,
  operation: (graph: Awaited<ReturnType<typeof readPackageGraph>>) => Promise<T>,
): Promise<T> {
  try {
    return await operation(
      await readPackageGraph({
        sourceDir: resolved.sourceDir,
        kind: resolved.kind,
        fetcher,
        origin: {
          url: resolved.sourcePathOverride ?? resolved.sourceDir,
          ref: resolved.sourceRef ?? "",
          commitSha: resolved.sourceCommitSha,
        },
      }),
    );
  } catch (error) {
    throw toPackageRouteError(error);
  } finally {
    await resolved.cleanup();
  }
}
export async function previewPackageInstall(input: InstallInput) {
  return withSource(await resolvePackageInstallSource(input), input.fetcher, (graph) =>
    previewPackageGraph(input.store, input.userId, graph),
  );
}
export async function applyPackageInstall(input: InstallInput) {
  return withSource(await resolvePackageInstallSource(input), input.fetcher, (graph) =>
    importPackageGraph(input.store, input.userId, graph),
  );
}
export async function findOwnedPackageInstall(
  store: AgentRevisionStore,
  userId: string,
  installId: string,
) {
  try {
    return await findOwnedInstallation(store, userId, installId);
  } catch (error) {
    throw toPackageRouteError(error);
  }
}
async function resolveUpdateSource(
  install: AgentPackageInstallation,
  fetcher: MarsPackageFetcher,
): Promise<ResolvedMarsSource> {
  if (!install.origin)
    throw createError({ statusCode: 422, message: "Package has no upstream source" });
  if (!path.isAbsolute(install.origin.url))
    return resolveGitHubMarsSource({ url: install.origin.url, ref: install.origin.ref, fetcher });
  return {
    kind: "local",
    sourceDir: install.origin.url,
    sourceCommitSha: null,
    sourceRef: "",
    cleanup: async () => {},
  };
}
export async function checkPackageUpdate(input: UpdateInput) {
  const install = await findOwnedPackageInstall(input.store, input.userId, input.installId);
  return withSource(await resolveUpdateSource(install, input.fetcher), input.fetcher, (graph) =>
    updatePackageGraph(input.store, input.userId, install, graph, false),
  );
}
export async function applyPackageUpdate(input: UpdateInput): Promise<PackageUpdateApplyResponse> {
  const install = await findOwnedPackageInstall(input.store, input.userId, input.installId);
  const plan = await withSource(
    await resolveUpdateSource(install, input.fetcher),
    input.fetcher,
    (graph) => updatePackageGraph(input.store, input.userId, install, graph, true),
  );
  const slugs = (items: typeof plan.willKeep, kind: "agent" | "skill") =>
    items.filter((item) => item.kind === kind).map((item) => item.slug);
  return {
    installId: install.id,
    packageName: install.coordinate,
    version: plan.upstreamVersion,
    updatedAgents: slugs(plan.willUpdate, "agent"),
    updatedSkills: slugs(plan.willUpdate, "skill"),
    keptAgents: slugs(plan.willKeep, "agent"),
    keptSkills: slugs(plan.willKeep, "skill"),
    removedAgents: [],
    removedSkills: [],
    retiredAgents: slugs(plan.willRetire, "agent"),
    retiredSkills: slugs(plan.willRetire, "skill"),
  };
}
export function toPackageRouteError(error: unknown): Error {
  if (error instanceof AgentPublicationConflictError)
    return createError({ statusCode: 409, message: error.message });
  if (error instanceof PackageInstallationNotFoundError)
    return createError({ statusCode: 404, message: error.message });
  if (
    error instanceof AgentSourceError ||
    error instanceof AgentConfigurationError ||
    (error instanceof Error && error.message.includes("GitHub"))
  )
    return createError({ statusCode: 422, message: error.message });
  if (error instanceof Error) return error;
  return new Error(String(error));
}
