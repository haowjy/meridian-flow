/** Work catalog resolution, Works still being created, and remembered Work routing. */
import type { Work } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import { useCallback, useEffect, useRef, useState } from "react";
import { readCurrentWork, writeCurrentWork } from "@/client/current-work";
import { useWorks } from "@/client/query/useWorks";
import type { WorkCreation } from "@/client/query/work-command-projection";
import { useAccountId } from "../context/account-feature-context";
import type { ProjectAddress, ProjectDestination } from "./project-address";
import {
  type AddressCatalog,
  type AddressResolution,
  addressWorkSelection,
  resolveAddressSelection,
} from "./project-address-resolution";
import type { createProjectNavigation } from "./project-navigation";
import type { RouteWorkResolution } from "./project-route";

type WorkCatalog = AddressCatalog<Work> & {
  creations: ReadonlyMap<string, WorkCreation>;
  isFetching: boolean;
};
type WorkNavigation = ReturnType<typeof createProjectNavigation>;

export function workRouteResolution(resolution: AddressResolution<Work>): RouteWorkResolution {
  if (resolution.status === "resolved") {
    const workId = parseRequestId(resolution.value.id);
    if (!workId) throw new Error("Invalid persisted Work identity");
    return { status: "present", workId, work: resolution.value };
  }
  if (resolution.status === "loading" || resolution.status === "error")
    return { status: "unresolved", reason: resolution.status, id: resolution.id };
  if (resolution.status === "unavailable")
    return { status: "unresolved", reason: "unavailable", id: resolution.id };
  if (resolution.status === "malformed")
    return { status: "unresolved", reason: "unavailable", id: resolution.value };
  return { status: "none" };
}

function resolveWorkId(workId: string, catalog: WorkCatalog): AddressResolution<Work> {
  const work = catalog.entries?.find((entry) => entry.id === workId);
  if (work) return { status: "resolved", value: work };
  if (catalog.status === "loading" || catalog.status === "error")
    return { status: catalog.status, id: workId };
  return { status: "unavailable", id: workId };
}

const NO_WORKS: readonly Work[] = [];

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
  destination,
  address,
  navigation,
}: {
  projectId: string;
  destination: ProjectDestination;
  address: ProjectAddress;
  navigation: WorkNavigation | null;
}): {
  routeWork: RouteWorkResolution;
  workResolution: AddressResolution<Work>;
  workCatalog: WorkCatalog;
  rememberedWork: Work | null;
  openRemembered: () => Promise<void>;
} {
  const accountId = useAccountId();
  const catalog = useWorkCatalog(projectId);
  const requestedWork = addressWorkSelection(address);
  const routeWorkId =
    destination.kind === "work" || destination.kind === "document" || destination.kind === "browse"
      ? destination.workId
      : null;
  const workResolution = routeWorkId
    ? resolveWorkId(routeWorkId, catalog)
    : resolveAddressSelection(requestedWork, catalog);
  const creation = routeWorkId ? catalog.creations.get(routeWorkId) : undefined;
  const routeWork: RouteWorkResolution =
    destination.kind === "works-new"
      ? { status: "new" }
      : routeWorkId && creation
        ? {
            status: "creating",
            workId: routeWorkId,
            name: creation.work.name,
            goal: creation.work.goal,
            phase: creation.phase,
          }
        : workRouteResolution(workResolution);

  const [rememberedId, setRememberedId] = useState(() => readCurrentWork(accountId, projectId));
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
    const current = latest.current;
    const work = current.rememberedWork;
    if (!current.navigation || !work) return;
    const workId = parseRequestId(work.id);
    if (!workId) return;
    const destination: ProjectDestination = { kind: "work", workId };
    await current.navigation.navigate(
      {
        ...current.address,
        destination,
        workView: undefined,
        worksView: undefined,
        results: false,
      },
      { replace: false },
    );
  }, []);

  return {
    routeWork,
    workResolution,
    workCatalog: catalog,
    rememberedWork,
    openRemembered,
  };
}
