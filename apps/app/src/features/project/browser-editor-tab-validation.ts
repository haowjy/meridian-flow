/** Validates this browser tab's persisted Editor membership against current resources. */

import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import {
  type ContextOwner,
  isProjectContextTreeScheme,
  type ProjectContextIdentityResolution,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import {
  createResourcePlacement,
  type ResourceIdentityIndex,
  type ResourceRecord,
  resourceIdentityIndex,
  resourcePlacementForSnapshot,
  resourceVisibleInProject,
} from "@meridian/resource-replica";
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
import {
  contextTabFromFile,
  contextTabFromResource,
  editorTabWorkId,
} from "./context/context-tab-from-file";

export type EditorTabValidationScope = {
  projectId: string;
  generation: number;
};

type EditorTabValidationGuard = (scope: EditorTabValidationScope) => boolean;

type ValidatedRoute = { tab: ContextTab | null; removedRoute: WorkingSetRoute | null };

/** A stable handle names the resource; otherwise the replica's one alias rule resolves the id. */
function resourceRecordForTab(
  index: ResourceIdentityIndex,
  tab: ContextTab,
): ResourceRecord | undefined {
  return (
    (tab.resourceHandle ? index.byHandle(tab.resourceHandle) : null) ??
    index.byDocumentId(tab.documentId) ??
    undefined
  );
}

function availableTab(
  resolution: Extract<ProjectContextIdentityResolution, { kind: "available" }>,
): ContextTab {
  const scheme = resolution.entry.uri.slice(0, resolution.entry.uri.indexOf(":"));
  if (!isProjectContextTreeScheme(scheme)) throw new TypeError("Invalid available route scheme");
  const authorityKind = resolution.authority.kind;
  if (
    scheme === "uploads"
      ? authorityKind !== "chat"
      : isWorkScopedScheme(scheme) && authorityKind !== "work" && authorityKind !== "lineage"
  ) {
    throw new TypeError("Invalid available route authority");
  }
  const owner: ContextOwner =
    resolution.authority.kind === "chat"
      ? {
          chatThreadId: resolution.authority.chatId,
          chatRef: resolution.authority.chatRef ?? undefined,
        }
      : resolution.authority.kind === "lineage"
        ? { rootThreadId: resolution.authority.rootThreadId }
        : {
            workId:
              resolution.authority.kind === "work" ? editorTabWorkId(resolution.authority) : null,
          };
  return contextTabFromFile(scheme, projectCatalogFile(resolution.entry), owner);
}

export async function validateServerRoute(
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
  const projection = needsProjection
    ? await resources.readProjection(projectId).then(
        (snapshot) => ({
          records: resourceIdentityIndex(
            snapshot.records.filter((record) =>
              resourceVisibleInProject(projectId, record, snapshot.catalogs),
            ),
          ),
          placement: resourcePlacementForSnapshot(projectId, snapshot),
        }),
        () => null,
      )
    : {
        records: resourceIdentityIndex([]),
        placement: createResourcePlacement(projectId, [], []),
      };
  const results = await Promise.allSettled(
    restored.map(
      async (tab): Promise<{ tab: ContextTab | null; removedRoute: WorkingSetRoute | null }> => {
        if (tab.kind === "new") {
          if (!projection) throw new Error("Resource projection is unavailable");
          const record = resourceRecordForTab(projection.records, tab);
          return {
            tab: record ? contextTabFromResource(projectId, record, projection.placement) : null,
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
        if (!projection) throw new Error("Resource projection is unavailable");
        const record = resourceRecordForTab(projection.records, tab);
        const projected = record
          ? contextTabFromResource(projectId, record, projection.placement)
          : null;
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
