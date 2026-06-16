/**
 * usePackageInstall — React Query hooks for package catalog, install preview/apply,
 * and update check/apply. Mutations invalidate the project library inventory.
 */

import type {
  PackageInstallApplyRequest,
  PackageInstallPreviewRequest,
  PackageInstallSource,
  PackageUpdateApplyResponse,
  PackageUpdateCheckResponse,
} from "@meridian/contracts/agents";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson, postJson } from "@/client/api/http-client";
import {
  applyPackageInstall,
  getPackagesCatalog,
  previewPackageInstall,
  projectPackageUpdateApplyPath,
  projectPackageUpdateCheckPath,
} from "@/client/api/package-install-api";

import { projectQueryKeys } from "./project-query-keys";

export const packageQueryKeys = {
  catalog: ["packages", "catalog"] as const,
  updateCheck: (projectId: string, installId: string) =>
    ["projects", projectId, "packages", installId, "update"] as const,
};

function invalidateLibrary(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.library(projectId) });
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.agents(projectId) });
}

export function usePackagesCatalog() {
  return useQuery({
    queryKey: packageQueryKeys.catalog,
    queryFn: getPackagesCatalog,
    staleTime: 300_000,
  });
}

export function usePreviewPackageInstall(projectId: string) {
  return useMutation({
    mutationFn: (body: PackageInstallPreviewRequest) => previewPackageInstall(projectId, body),
  });
}

export function useApplyPackageInstall(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PackageInstallApplyRequest) => applyPackageInstall(projectId, body),
    onSuccess: () => invalidateLibrary(queryClient, projectId),
  });
}

export function usePackageUpdateCheck(projectId: string, installId: string, enabled: boolean) {
  return useQuery({
    queryKey: packageQueryKeys.updateCheck(projectId, installId),
    queryFn: () =>
      getJson<PackageUpdateCheckResponse>(projectPackageUpdateCheckPath(projectId, installId)),
    enabled: enabled && Boolean(projectId && installId),
    retry: false,
  });
}

export function useApplyPackageUpdate(projectId: string, installId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      postJson<PackageUpdateApplyResponse>(projectPackageUpdateApplyPath(projectId, installId), {}),
    onSuccess: () => {
      invalidateLibrary(queryClient, projectId);
      void queryClient.invalidateQueries({
        queryKey: packageQueryKeys.updateCheck(projectId, installId),
      });
    },
  });
}

export type InstallSourceState = {
  source: PackageInstallSource;
  label: string;
};
