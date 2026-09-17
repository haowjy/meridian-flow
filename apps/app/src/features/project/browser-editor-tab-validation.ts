/** Validates this browser tab's persisted Editor membership against current resources. */

import {
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
  type ProjectContextIdentityResolution,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import { type ResourceRecord, resourceVisibleInProject } from "@meridian/resource-replica";
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { projectCatalogFile } from "@/client/query/useContextCatalog";
import {
  type ContextTab,
  reconcileEditorWorkspaceBootstrap,
  useContextTabsStore,
} from "@/client/stores";
import { reconcileContextRoutes } from "@/client/working-set";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { workingSetRouteForTab } from "./context/context-removal-planner";
import { contextTabFromFile, contextTabFromResource } from "./context/context-tab-from-file";

export type EditorTabValidationScope = {
  projectId: string;
  generation: number;
};

type EditorTabValidationGuard = (scope: EditorTabValidationScope) => boolean;

type ValidatedRoute = { tab: ContextTab | null; removedRoute: WorkingSetRoute | null };

function indexResourceRecords(records: readonly ResourceRecord[]): Map<string, ResourceRecord> {
  const index = new Map<string, ResourceRecord>();
  for (const record of records) {
    index.set(record.resource.handle, record);
    index.set(record.resource.identity.documentId, record);
    for (const alias of Object.keys(record.resource.aliases)) index.set(alias, record);
  }
  return index;
}

function resourceRecordForTab(
  index: ReadonlyMap<string, ResourceRecord>,
  tab: ContextTab,
): ResourceRecord | undefined {
  return (
    (tab.resourceHandle ? index.get(tab.resourceHandle) : undefined) ?? index.get(tab.documentId)
  );
}

function availableTab(
  resolution: Extract<ProjectContextIdentityResolution, { kind: "available" }>,
): ContextTab {
  const scheme = resolution.entry.uri.slice(0, resolution.entry.uri.indexOf(":"));
  if (!isProjectContextTreeScheme(scheme)) throw new TypeError("Invalid available route scheme");
  const workId = isWorkScopedProjectContextScheme(scheme)
    ? resolution.authority.kind === "work"
      ? resolution.authority.workId
      : undefined
    : undefined;
  if (isWorkScopedProjectContextScheme(scheme) && workId === undefined) {
    throw new TypeError("Invalid available route authority");
  }
  return contextTabFromFile(scheme, projectCatalogFile(resolution.entry), workId);
}

async function validateServerRoute(
  projectId: string,
  route: WorkingSetRoute,
): Promise<ValidatedRoute> {
  const result = await lookupProjectContextAvailability(projectId, [route.documentId]);
  const resolution = result.resolutions[0];
  if (!resolution || resolution.documentId !== route.documentId) {
    throw new TypeError("Invalid project availability response");
  }
  if (resolution.kind === "available") {
    const tab = availableTab(resolution);
    if (tab.documentId !== route.documentId) {
      throw new TypeError("Availability entry does not match its stable identity");
    }
    return { tab, removedRoute: route };
  }
  if (resolution.kind === "indeterminate") throw new Error("Document identity is indeterminate");
  return { tab: null, removedRoute: route };
}

/** Refreshes restored tab metadata and drops routes that no longer exist. */
export async function validateEditorWorkspaceTabs({
  resources,
  scope,
  isLiveScope,
}: {
  resources: Pick<AccountResourceReplica, "readProjection">;
  scope: EditorTabValidationScope;
  isLiveScope: EditorTabValidationGuard;
}): Promise<void> {
  const { projectId } = scope;
  const restored = useContextTabsStore.getState().byProject[projectId]?.tabs ?? [];
  const needsProjection = restored.some(
    (tab) => tab.kind === "new" || (tab.kind === "tracked" && tab.origin === "local-resource"),
  );
  const recordIndex = needsProjection
    ? await resources.readProjection(projectId).then(
        (snapshot) =>
          indexResourceRecords(
            snapshot.records.filter((record) =>
              resourceVisibleInProject(projectId, record, snapshot.catalogs),
            ),
          ),
        () => null,
      )
    : new Map<string, ResourceRecord>();
  const results = await Promise.allSettled(
    restored.map(
      async (tab): Promise<{ tab: ContextTab | null; removedRoute: WorkingSetRoute | null }> => {
        if (tab.kind === "new") {
          if (!recordIndex) throw new Error("Resource projection is unavailable");
          const record = resourceRecordForTab(recordIndex, tab);
          return {
            tab: record ? contextTabFromResource(projectId, record) : null,
            removedRoute: null,
          };
        }
        if (tab.kind !== "tracked" || tab.origin !== "local-resource") {
          const restored = await validateServerRoute(
            projectId,
            workingSetRouteForTab(tab) as WorkingSetRoute,
          );
          return restored;
        }
        if (!recordIndex) throw new Error("Resource projection is unavailable");
        const record = resourceRecordForTab(recordIndex, tab);
        const projected = record ? contextTabFromResource(projectId, record) : null;
        return {
          tab: projected,
          removedRoute: projected ? null : workingSetRouteForTab(tab),
        };
      },
    ),
  );
  const tabs = results.flatMap((result, index) => {
    // A transient tree read must not turn read degradation into destructive pruning.
    if (result.status === "rejected") {
      return [{ tab: restored[index] as ContextTab, removedRoute: null }];
    }
    return [result.value];
  });
  if (!isLiveScope(scope)) return;
  const survivingTabs = tabs.flatMap(({ tab }) => (tab ? [tab] : []));
  reconcileContextRoutes(projectId, {
    removedLocators: tabs.flatMap(({ removedRoute }) => removedRoute ?? []),
    survivingOwnedLocators: survivingTabs.flatMap((tab) =>
      tab.kind === "new" ? [] : (workingSetRouteForTab(tab) ?? []),
    ),
    promote: null,
    clearAll: false,
  });
  await reconcileEditorWorkspaceBootstrap(
    projectId,
    tabs.map(({ tab }, index) => ({ prior: restored[index] as ContextTab, next: tab })),
  );
}
