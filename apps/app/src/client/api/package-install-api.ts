/**
 * package-install-api — typed HTTP client for Mars package install preview/apply
 * and the first-party install gallery catalog.
 */
import type {
  FirstPartyCatalogResponse,
  PackageInstallApplyRequest,
  PackageInstallApplyResponse,
  PackageInstallPreviewRequest,
  PackageInstallPreviewResponse,
} from "@meridian/contracts/agents";

import { getJson, postJson } from "./http-client";

export function packagesCatalogPath(): string {
  return "/api/packages/catalog";
}

export function projectPackagePreviewPath(projectId: string): string {
  return `/api/projects/${projectId}/packages/preview`;
}

export function projectPackageApplyPath(projectId: string): string {
  return `/api/projects/${projectId}/packages`;
}

export function projectPackageUpdateCheckPath(projectId: string, installId: string): string {
  return `/api/projects/${projectId}/packages/${installId}/update`;
}

export function projectPackageUpdateApplyPath(projectId: string, installId: string): string {
  return `/api/projects/${projectId}/packages/${installId}/update`;
}

export function projectPackageExportPath(projectId: string, installId: string): string {
  return `/api/projects/${projectId}/packages/${installId}/export`;
}

export async function getPackagesCatalog(): Promise<FirstPartyCatalogResponse> {
  return getJson<FirstPartyCatalogResponse>(packagesCatalogPath());
}

export async function previewPackageInstall(
  projectId: string,
  body: PackageInstallPreviewRequest,
): Promise<PackageInstallPreviewResponse> {
  return postJson<PackageInstallPreviewResponse>(projectPackagePreviewPath(projectId), body);
}

export async function applyPackageInstall(
  projectId: string,
  body: PackageInstallApplyRequest,
): Promise<PackageInstallApplyResponse> {
  return postJson<PackageInstallApplyResponse>(projectPackageApplyPath(projectId), body);
}
