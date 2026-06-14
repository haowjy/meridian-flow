/**
 * Project package install route core: owner-gated preview and apply for Mars
 * packages from GitHub URLs or the first-party catalog.
 */
import type {
  PackageInstallApplyRequest,
  PackageInstallApplyResponse,
  PackageInstallPreviewRequest,
  PackageInstallPreviewResponse,
  PackageInstallSource,
} from "@meridian/contracts/agents";
import { createError } from "nitro/h3";

import {
  applyPackageInstall,
  type MarsPackageFetcher,
  type PackageRepository,
  previewPackageInstall,
} from "../domains/packages/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";

export interface ProjectPackageInstallRouteDeps {
  projectRepo: ProjectRepository;
  packageRepository: PackageRepository;
  marsPackageFetcher: MarsPackageFetcher;
}

export interface ProjectPackageInstallRouteInput {
  projectId: string;
  userId: string;
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createError({ statusCode: 400, message: `${label} must be an object` });
  }
  return value as Record<string, unknown>;
}

export function parsePackageInstallSource(raw: unknown): PackageInstallSource {
  const body = assertObject(raw, "Request body");
  const source = assertObject(body.source, "`source`");
  const kind = source.kind;
  if (kind === "github") {
    if (typeof source.url !== "string" || source.url.trim().length === 0) {
      throw createError({ statusCode: 400, message: "`source.url` must be a non-empty string" });
    }
    return {
      kind: "github",
      url: source.url.trim(),
      ref: typeof source.ref === "string" ? source.ref.trim() : undefined,
    };
  }
  if (kind === "catalog") {
    if (typeof source.catalogId !== "string" || source.catalogId.trim().length === 0) {
      throw createError({
        statusCode: 400,
        message: "`source.catalogId` must be a non-empty string",
      });
    }
    return { kind: "catalog", catalogId: source.catalogId.trim() };
  }
  throw createError({
    statusCode: 400,
    message: '`source.kind` must be "github" or "catalog"',
  });
}

export function parsePackageInstallPreviewRequest(raw: unknown): PackageInstallPreviewRequest {
  return { source: parsePackageInstallSource(raw) };
}

export function parsePackageInstallApplyRequest(raw: unknown): PackageInstallApplyRequest {
  return { source: parsePackageInstallSource(raw) };
}

export async function handlePreviewPackageInstallRequest(
  deps: ProjectPackageInstallRouteDeps,
  input: ProjectPackageInstallRouteInput & PackageInstallPreviewRequest,
): Promise<PackageInstallPreviewResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  return previewPackageInstall({
    projectId: input.projectId,
    source: input.source,
    repository: deps.packageRepository,
    fetcher: deps.marsPackageFetcher,
  });
}

export async function handleApplyPackageInstallRequest(
  deps: ProjectPackageInstallRouteDeps,
  input: ProjectPackageInstallRouteInput & PackageInstallApplyRequest,
): Promise<PackageInstallApplyResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  return applyPackageInstall({
    projectId: input.projectId,
    source: input.source,
    repository: deps.packageRepository,
    fetcher: deps.marsPackageFetcher,
  });
}
