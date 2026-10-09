/** Normalize Editor Works to row identities; screen chrome separately omits the locked No Work row. */
import { parseRequestId } from "@meridian/contracts/request-id";
import { useCallback, useEffect, useRef, useState } from "react";
import { readCurrentWork, writeCurrentWork } from "@/client/current-work";
import { type AddressableWork, useWorks } from "@/client/query/useWorks";
import type { WorkCreation } from "@/client/query/work-command-projection";
import { useAccountId } from "../context/account-feature-context";
import type { AddressSelection, ProjectAddress, ProjectDestination } from "./project-address";
import { type AddressCatalog, addressWorkSelection } from "./project-address-resolution";
import type { createProjectNavigation } from "./project-navigation";
import type { RouteWorkResolution } from "./project-route";

export type WorkCatalog = AddressCatalog<AddressableWork> & {
  creations: ReadonlyMap<string, WorkCreation>;
  isFetching: boolean;
  /** Locked row, or null before the snapshot arrives. */
  noWork: AddressableWork | null;
};
type WorkNavigation = ReturnType<typeof createProjectNavigation>;

/** Resolve public No Work grammar to its row, or wait for the catalog without inventing an id. */
export function resolveRouteWork(
  selection: Exclude<AddressSelection, { kind: "absent" }>,
  catalog: WorkCatalog,
): Exclude<RouteWorkResolution, { status: "new" | "absent" }>;
export function resolveRouteWork(
  selection: AddressSelection,
  catalog: WorkCatalog,
): Exclude<RouteWorkResolution, { status: "new" }>;
export function resolveRouteWork(
  selection: AddressSelection,
  catalog: WorkCatalog,
): RouteWorkResolution {
  if (selection.kind === "absent") return { status: "absent" };
  if (selection.kind === "none") {
    return catalog.noWork
      ? { status: "present", workId: catalog.noWork.id, work: catalog.noWork }
      : {
          status: "unresolved",
          reason: catalog.status === "error" ? "error" : "loading",
          workId: null,
        };
  }
  if (selection.kind === "malformed")
    return { status: "unresolved", reason: "unavailable", workId: null };
  const workId = selection.id;
  if (catalog.noWork?.id && workId === catalog.noWork?.id)
    return { status: "present", workId: catalog.noWork.id, work: catalog.noWork };
  const work = catalog.entries?.find((entry) => entry.id === workId);
  if (work) return { status: "present", workId, work };
  const creation = catalog.creations.get(workId);
  if (creation) {
    const { name, goal } = creation.work;
    return { status: "creating", workId, name, goal, phase: creation.phase };
  }
  return {
    status: "unresolved",
    reason: catalog.status === "ready" ? "unavailable" : catalog.status,
    workId,
  };
}

/** Screen chrome never treats the locked row as a named Work destination. */
export function collapseScreenWork(
  resolution: RouteWorkResolution,
  destination: ProjectDestination,
): RouteWorkResolution {
  if (resolution.status !== "present" || !resolution.work.isNoWork) return resolution;
  return destination.kind === "work"
    ? { status: "unresolved", reason: "unavailable", workId: resolution.workId }
    : { status: "absent" };
}

const NO_WORKS: readonly AddressableWork[] = [];

/** The projected Works a route can resolve, and those still being created. */
export function useWorkCatalog(projectId: string): WorkCatalog {
  const works = useWorks(projectId);
  const status =
    works.status === "ready" || works.status === "empty"
      ? "ready"
      : works.status === "error"
        ? "error"
        : "loading";
  return {
    status,
    entries: works.works ?? NO_WORKS,
    creations: works.creations,
    isFetching: works.isFetching,
    noWork: works.noWork,
  };
}

/** Owns Work route resolution plus both remembered-Work reads and writes. */
export function useWorkRoute({
  projectId,
  address,
  navigation,
}: {
  projectId: string;
  address: ProjectAddress;
  navigation: WorkNavigation | null;
}): {
  routeWork: RouteWorkResolution;
  workCatalog: WorkCatalog;
  rememberedWork: AddressableWork | null;
  openRemembered: () => Promise<void>;
} {
  const accountId = useAccountId();
  const catalog = useWorkCatalog(projectId);
  const selection = addressWorkSelection(address);
  const routeWork =
    address.destination.kind === "works-new"
      ? { status: "new" as const }
      : collapseScreenWork(resolveRouteWork(selection, catalog), address.destination);

  const [rememberedId, setRememberedId] = useState(() =>
    parseRequestId(readCurrentWork(accountId, projectId)),
  );
  const rememberedWork = catalog.entries?.find((entry) => entry.id === rememberedId) ?? null;
  const latest = useRef({ address, navigation, rememberedWork });
  latest.current = { address, navigation, rememberedWork };

  // No Work collapses to `absent`, so it is never the remembered Work: it has no
  // Work screen to return to.
  const activeWorkId = routeWork.status === "present" ? routeWork.workId : null;
  useEffect(() => {
    if (!activeWorkId) return;
    writeCurrentWork(accountId, projectId, activeWorkId);
    setRememberedId(activeWorkId);
  }, [accountId, activeWorkId, projectId]);

  const openRemembered = useCallback(async () => {
    const { address, navigation, rememberedWork } = latest.current;
    if (!navigation || !rememberedWork) return;
    const destination: ProjectDestination = { kind: "work", workId: rememberedWork.id };
    await navigation.navigate(
      { ...address, destination, workView: undefined, worksView: undefined },
      { replace: false },
    );
  }, []);

  return { routeWork, workCatalog: catalog, rememberedWork, openRemembered };
}
