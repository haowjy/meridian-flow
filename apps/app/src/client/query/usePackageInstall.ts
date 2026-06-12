// @ts-nocheck
/**
 * usePackageInstall — React Query hooks for package catalog, install preview/apply,
 * and update check/apply. Mutations invalidate the workbench library inventory.
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
  workbenchPackageUpdateApplyPath,
  workbenchPackageUpdateCheckPath,
} from "@/client/api/package-install-api";

import { workbenchQueryKeys } from "./workbench-query-keys";

export const packageQueryKeys = {
  catalog: ["packages", "catalog"] as const,
  updateCheck: (workbenchId: string, installId: string) =>
    ["workbenches", workbenchId, "packages", installId, "update"] as const,
};

function invalidateLibrary(
  queryClient: ReturnType<typeof useQueryClient>,
  workbenchId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.library(workbenchId) });
  void queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.agents(workbenchId) });
}

export function usePackagesCatalog() {
  return useQuery({
    queryKey: packageQueryKeys.catalog,
    queryFn: getPackagesCatalog,
    staleTime: 300_000,
  });
}

export function usePreviewPackageInstall(workbenchId: string) {
  return useMutation({
    mutationFn: (body: PackageInstallPreviewRequest) => previewPackageInstall(workbenchId, body),
  });
}

export function useApplyPackageInstall(workbenchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PackageInstallApplyRequest) => applyPackageInstall(workbenchId, body),
    onSuccess: () => invalidateLibrary(queryClient, workbenchId),
  });
}

export function usePackageUpdateCheck(workbenchId: string, installId: string, enabled: boolean) {
  return useQuery({
    queryKey: packageQueryKeys.updateCheck(workbenchId, installId),
    queryFn: () =>
      getJson<PackageUpdateCheckResponse>(workbenchPackageUpdateCheckPath(workbenchId, installId)),
    enabled: enabled && Boolean(workbenchId && installId),
    retry: false,
  });
}

export function useApplyPackageUpdate(workbenchId: string, installId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      postJson<PackageUpdateApplyResponse>(
        workbenchPackageUpdateApplyPath(workbenchId, installId),
        {},
      ),
    onSuccess: () => {
      invalidateLibrary(queryClient, workbenchId);
      void queryClient.invalidateQueries({
        queryKey: packageQueryKeys.updateCheck(workbenchId, installId),
      });
    },
  });
}

export type InstallSourceState = {
  source: PackageInstallSource;
  label: string;
};
