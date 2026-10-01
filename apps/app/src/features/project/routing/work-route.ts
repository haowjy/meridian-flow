/** Work route resolution, Works still being created, and remembered Work routing. */
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
};
type WorkNavigation = ReturnType<typeof createProjectNavigation>;

/** Which Work an address selection names, against the projected catalog and its creations. */
export function resolveRouteWork(
  selection: AddressSelection,
  catalog: WorkCatalog,
): RouteWorkResolution {
  if (selection.kind === "absent" || selection.kind === "none") return { status: "none" };
  if (selection.kind === "malformed")
    return { status: "unresolved", reason: "unavailable", workId: null };
  const workId = selection.id;
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
  const routeWork: RouteWorkResolution =
    address.destination.kind === "works-new"
      ? { status: "new" }
      : resolveRouteWork(addressWorkSelection(address), catalog);

  const [rememberedId, setRememberedId] = useState(() =>
    parseRequestId(readCurrentWork(accountId, projectId)),
  );
  const rememberedWork = catalog.entries?.find((entry) => entry.id === rememberedId) ?? null;
  const latest = useRef({ address, navigation, rememberedWork });
  latest.current = { address, navigation, rememberedWork };

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
      { ...address, destination, workView: undefined, worksView: undefined, results: false },
      { replace: false },
    );
  }, []);

  return { routeWork, workCatalog: catalog, rememberedWork, openRemembered };
}
