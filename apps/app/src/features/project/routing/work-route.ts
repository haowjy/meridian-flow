/** Work catalog resolution, id canonicalization, and remembered Work routing. */
import type { Work } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { creationRecordKey, removeCreationRecord } from "@/client/creation/creation-registry";
import { readCurrentWork, writeCurrentWork } from "@/client/current-work";
import { useWorks } from "@/client/query/useWorks";
import type { WorkCreationRecord } from "@/features/project/work/useWorkCreation";
import { useWorkCreationRecords } from "@/features/project/work/useWorkCreation";
import { useAccountId } from "../context/account-feature-context";
import {
  confirmedWorkAddress,
  type ProjectAddress,
  type ProjectDestination,
} from "./project-address";
import {
  type AddressCatalog,
  type AddressResolution,
  addressWorkSelection,
  resolveAddressSelection,
} from "./project-address-resolution";
import type { createProjectNavigation } from "./project-navigation";
import type { RouteWorkResolution, WorkDetailTarget } from "./project-route";

type WorkCatalog = AddressCatalog<Work> & {
  creations: readonly WorkCreationRecord[];
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
    return { status: "unresolved", reason: resolution.status, slug: resolution.slug };
  if (resolution.status === "unavailable" || resolution.status === "malformed")
    return {
      status: "unresolved",
      reason: "unavailable",
      slug: resolution.status === "malformed" ? resolution.value : resolution.slug,
    };
  return { status: "none" };
}

function workCreationForId(
  workId: string,
  creations: readonly WorkCreationRecord[],
): WorkCreationRecord | undefined {
  return creations.find((creation) => creation.workId === workId);
}

function resolveWorkId(workId: string, catalog: WorkCatalog): AddressResolution<Work> {
  const work = catalog.entries?.find((entry) => entry.id === workId);
  if (work) return { status: "resolved", value: work };
  if (catalog.status === "loading" || catalog.status === "error")
    return { status: catalog.status, slug: workId };
  return { status: "unavailable", slug: workId };
}

/** One account-filtered projection of the server snapshot and confirmed creates. */
export function useWorkCatalog(projectId: string): WorkCatalog {
  const accountId = useAccountId();
  const works = useWorks(projectId);
  const creations = useWorkCreationRecords(projectId);
  const confirmed = useMemo(
    () => creations.filter((creation) => creation.status === "confirmed" && creation.work),
    [creations],
  );
  const entries = useMemo(() => {
    const byId = new Map<string, Work>();
    for (const work of works.works ?? []) byId.set(work.id, work);
    for (const creation of confirmed) {
      if (!byId.has(creation.workId) && creation.work) byId.set(creation.workId, creation.work);
    }
    return [...byId.values()];
  }, [confirmed, works.works]);
  const confirmedSnapshotIds = useMemo(
    () => new Set(works.works?.map((work) => work.id) ?? []),
    [works.works],
  );

  useEffect(() => {
    if (works.status !== "ready" && works.status !== "empty") return;
    for (const creation of confirmed) {
      if (confirmedSnapshotIds.has(creation.workId)) {
        removeCreationRecord(creationRecordKey("work", creation.workId), accountId);
      }
    }
  }, [accountId, confirmed, confirmedSnapshotIds, works.status]);

  const status =
    works.status === "ready" || works.status === "empty"
      ? "ready"
      : works.status === "error"
        ? "error"
        : "loading";
  return { status, entries, creations, isFetching: works.isFetching };
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
  const creations = catalog.creations;
  const requestedWork = addressWorkSelection(address);
  const workResolution =
    destination.kind === "work-id"
      ? resolveWorkId(destination.workId, catalog)
      : resolveAddressSelection(requestedWork, catalog);
  const pendingCreation =
    destination.kind === "work-id" ? workCreationForId(destination.workId, creations) : undefined;
  const pendingWorkId = pendingCreation ? parseRequestId(pendingCreation.workId) : null;
  const routeWork: RouteWorkResolution =
    destination.kind === "works-new"
      ? { status: "new" }
      : pendingWorkId &&
          (pendingCreation?.status === "pending" || pendingCreation?.status === "failed")
        ? {
            status: "creating",
            workId: pendingWorkId,
            name: pendingCreation.request.name,
            goal: pendingCreation.request.goal ?? null,
            phase: pendingCreation.status,
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

  const canonicalWorkId =
    destination.kind === "work-id" && workResolution.status === "resolved"
      ? workResolution.value.id
      : null;
  const canonicalWorkSlug =
    destination.kind === "work-id" && workResolution.status === "resolved"
      ? workResolution.value.slug
      : null;
  useEffect(() => {
    const current = latest.current;
    if (!current.navigation || !canonicalWorkId || !canonicalWorkSlug) return;
    const next = confirmedWorkAddress(current.address, canonicalWorkId, canonicalWorkSlug);
    if (next !== current.address) void current.navigation.navigate(next, { replace: true });
  }, [canonicalWorkId, canonicalWorkSlug, navigation]);

  const openRemembered = useCallback(async () => {
    const current = latest.current;
    const work = current.rememberedWork;
    if (!current.navigation || !work) return;
    const workId = parseRequestId(work.id);
    if (!workId) return;
    const destination: ProjectDestination = work.slug
      ? { kind: "work", workSlug: work.slug }
      : { kind: "work-id", workId };
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

export function workDestination(
  workId: WorkDetailTarget["workId"],
  catalog: WorkCatalog,
): ProjectDestination {
  const work = catalog.entries?.find((entry) => entry.id === workId);
  return work?.slug ? { kind: "work", workSlug: work.slug } : { kind: "work-id", workId };
}
