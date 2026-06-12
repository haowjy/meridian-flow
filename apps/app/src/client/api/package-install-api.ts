// @ts-nocheck
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

export function workbenchPackagePreviewPath(workbenchId: string): string {
  return `/api/workbenches/${workbenchId}/packages/preview`;
}

export function workbenchPackageApplyPath(workbenchId: string): string {
  return `/api/workbenches/${workbenchId}/packages`;
}

export function workbenchPackageUpdateCheckPath(workbenchId: string, installId: string): string {
  return `/api/workbenches/${workbenchId}/packages/${installId}/update`;
}

export function workbenchPackageUpdateApplyPath(workbenchId: string, installId: string): string {
  return `/api/workbenches/${workbenchId}/packages/${installId}/update`;
}

export function workbenchPackageExportPath(workbenchId: string, installId: string): string {
  return `/api/workbenches/${workbenchId}/packages/${installId}/export`;
}

export async function getPackagesCatalog(): Promise<FirstPartyCatalogResponse> {
  return getJson<FirstPartyCatalogResponse>(packagesCatalogPath());
}

export async function previewPackageInstall(
  workbenchId: string,
  body: PackageInstallPreviewRequest,
): Promise<PackageInstallPreviewResponse> {
  return postJson<PackageInstallPreviewResponse>(workbenchPackagePreviewPath(workbenchId), body);
}

export async function applyPackageInstall(
  workbenchId: string,
  body: PackageInstallApplyRequest,
): Promise<PackageInstallApplyResponse> {
  return postJson<PackageInstallApplyResponse>(workbenchPackageApplyPath(workbenchId), body);
}
