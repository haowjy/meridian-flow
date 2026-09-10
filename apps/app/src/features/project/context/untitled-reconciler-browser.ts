/** Browser adapters and React bindings for the durable untitled reconciler engine. */

import { useSyncExternalStore } from "react";
import { createUntitledContextDocument } from "@/client/api/projects-api";
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import {
  publishLocalUntitledAdoption,
  publishLocalUntitledRemint,
  useContextTabsStore,
} from "@/client/stores";
import type { ContextIdentityMutationService } from "./context-identity-mutation";
import type { DesiredIdentity } from "./identity-location";
import type { LocalUntitledOwner } from "./local-untitled-owner";
import type { ProjectDocumentLiveOpener } from "./open-project-document";
import type {
  ProjectContextAvailabilityCoordinator,
  ProjectDocumentOpenResolution,
} from "./project-context-availability-coordinator";
import {
  type PendingUntitled,
  type QueuedIdentityFailure,
  resolveUntitledHome,
  UntitledReconciler,
  type UntitledReconcilerDeps,
} from "./untitled-reconciler";

function browserDeps(
  identityMutations: ContextIdentityMutationService,
  localOwner: LocalUntitledOwner,
  opener: ProjectDocumentLiveOpener,
  availability: ProjectContextAvailabilityCoordinator,
): UntitledReconcilerDeps {
  const localKey = (projectId: string, documentId: string) => ({
    accountId: localOwner.accountId,
    projectId,
    documentId,
  });
  return {
    scheduler: {
      queue: (task) => queueMicrotask(task),
      setTimer: (task, delayMs) => setTimeout(task, delayMs),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      onOnline: (task) => {
        window.addEventListener("online", task);
        return () => window.removeEventListener("online", task);
      },
    },
    newDocumentId: () => crypto.randomUUID(),
    localOwner: {
      accountId: localOwner.accountId,
      list: () => localOwner.listWork(),
      read: (projectId, documentId) => localOwner.readWork(localKey(projectId, documentId)),
      write: (record) => localOwner.writeWork(record),
      async acknowledgeReconciliation(projectId, documentId, expectedRevision) {
        const result = await localOwner.acknowledgeReconciliation(
          localKey(projectId, documentId),
          expectedRevision,
        );
        if (result !== "acknowledged") throw new Error("Local Untitled work revision is stale");
      },
      async acknowledgeFailureCleared(projectId, documentId, expectedRevision) {
        const result = await localOwner.acknowledgeFailureCleared(
          localKey(projectId, documentId),
          expectedRevision,
        );
        if (result !== "acknowledged") throw new Error("Local Untitled failure revision is stale");
      },
      async acknowledgeAdoptionPublication(projectId, documentId) {
        const result = await localOwner.acknowledgeAdoptionPublication(
          localKey(projectId, documentId),
        );
        if (result !== "acknowledged")
          throw new Error("Local Untitled adoption publication is stale");
      },
      publishAdoption(obligation, result) {
        return publishLocalUntitledAdoption({
          lineageHandle: obligation.lineageHandle,
          adoptionRevision: obligation.adoptionRevision,
          trackedTab: {
            kind: "tracked",
            documentId: obligation.documentId,
            scheme: result.scheme,
            path: result.path,
            name: result.name,
            workId: result.workId ?? undefined,
            editable: true,
            filetype: "markdown",
            schemaType: "document",
            provisionalName: true,
            origin: "local-untitled",
          },
        });
      },
      get: (projectId: string, documentId: string) =>
        localOwner.getDetached(localKey(projectId, documentId))?.session ?? null,
      async restore(projectId: string, documentId: string) {
        const result = await localOwner.restore(localKey(projectId, documentId));
        if (result.kind !== "opened")
          throw new Error("Local Untitled is owned in another browser tab");
        return {
          session: result.value.session,
          documentId: result.value.key.documentId,
        };
      },
      retain(ownerId: string, projectId: string, documentId: string) {
        localOwner.retain(ownerId, [localKey(projectId, documentId)]);
      },
      release: (ownerId: string) => localOwner.release(ownerId),
      revision: (projectId: string, documentId: string) =>
        localOwner.recordRevision(localKey(projectId, documentId)),
      prepare: (projectId: string, documentId: string, revision: number) =>
        localOwner.prepareMaterialization(localKey(projectId, documentId), revision),
      abort: (projectId, documentId, reservation) =>
        localOwner.abortMaterialization(localKey(projectId, documentId), reservation),
      open: (input) =>
        input.source === "local-untitled" && input.reservation
          ? opener.open({ ...input, source: "local-untitled", reservation: input.reservation })
          : input.source === "recover-local-adoption" && input.lineageHandle
            ? opener.open({
                source: "recover-local-adoption",
                projectId: input.projectId,
                documentId: input.documentId,
                lineageHandle: input.lineageHandle,
              })
            : opener.open({
                source: "server",
                projectId: input.projectId,
                documentId: input.documentId,
              }),
      async remint(projectId: string, from: string, to: string) {
        const committed = await localOwner.remint(
          localKey(projectId, from),
          localKey(projectId, to),
        );
        const publication = await publishLocalUntitledRemint({
          lineageHandle: committed.value.ref.lineageHandle,
          minimumIdentityRevision: committed.publication.minimumIdentityRevision,
          documentId: committed.value.key.documentId,
        });
        if (publication === "published" || publication === "not-referenced") {
          await localOwner.acknowledgeRemintPublication({
            ref: committed.value.ref,
            ...committed.publication,
          });
        }
        return committed.value.session;
      },
      async abandon(projectId: string, documentId: string, revision: number) {
        const result = await localOwner.abandon({
          key: localKey(projectId, documentId),
          expectedRevision: revision,
          evidence: "server-row-absent",
        });
        if (result !== "abandoned") throw new Error(`Local abandon was ${result}`);
      },
      phase: (projectId: string, documentId: string) =>
        localOwner.phase(localKey(projectId, documentId)),
    },
    api: {
      resolveHome: resolveUntitledCatalogHome,
      async create(entry) {
        return createUntitledContextDocument(
          entry.projectId,
          entry.home.scheme,
          {
            documentId: entry.documentId,
            ...(entry.home.folderPath ? { folderPath: entry.home.folderPath } : {}),
          },
          { workId: entry.home.workId },
        );
      },
      materialized: (projectId, result) => identityMutations.materialized(projectId, result),
      async confirmCreate(entry) {
        return confirmUntitledCreate(availability, entry.projectId, entry.documentId);
      },
      async move(entry, source, desired: DesiredIdentity) {
        const { result } = await identityMutations.move(
          entry.documentId,
          entry.projectId,
          {
            scheme: source.scheme,
            path: source.path,
            ...(source.workId ? { workId: source.workId } : {}),
          },
          desired,
        );
        return result;
      },
      async lookupGeneration(projectId, documentId) {
        const result = await lookupProjectContextAvailability(projectId, [documentId]);
        const resolution = result.resolutions[0];
        if (resolution?.kind !== "available") {
          throw new Error("Materialized Untitled is not authoritatively available");
        }
        return resolution.generation;
      },
    },
  };
}

export function confirmUntitledCreate(
  availability: Pick<ProjectContextAvailabilityCoordinator, "resolveForOpen">,
  projectId: string,
  documentId: string,
): Promise<ProjectDocumentOpenResolution> {
  return availability.resolveForOpen(projectId, documentId);
}

export async function resolveUntitledCatalogHome(_projectId: string) {
  return resolveUntitledHome(null);
}

let shared: UntitledReconciler | null = null;
const accountReconcilers = new WeakMap<LocalUntitledOwner, UntitledReconciler>();
const noopSubscribe = () => () => {};

export function getUntitledReconciler(
  identityMutations?: ContextIdentityMutationService,
  localOwner?: LocalUntitledOwner,
  opener?: ProjectDocumentLiveOpener,
  availability?: ProjectContextAvailabilityCoordinator,
): UntitledReconciler {
  if (localOwner && identityMutations && opener && availability && typeof window !== "undefined") {
    let account = accountReconcilers.get(localOwner);
    if (!account) {
      account = new UntitledReconciler(
        browserDeps(identityMutations, localOwner, opener, availability),
      );
      accountReconcilers.set(localOwner, account);
    }
    shared = account;
    return account;
  }
  if (!shared) throw new Error("Untitled reconciler is browser-only");
  return shared;
}

export function registerUntitledCandidate(
  projectId: string,
  documentId: string,
  candidate: Parameters<UntitledReconciler["registerCandidate"]>[2],
): () => void {
  return getUntitledReconciler().registerCandidate(projectId, documentId, candidate);
}

export function syncUntitledReceiptOwners(): void {
  const referencedEntries = Object.entries(useContextTabsStore.getState().byProject).flatMap(
    ([projectId, desk]) => desk.tabs.map((tab) => ({ projectId, documentId: tab.documentId })),
  );
  getUntitledReconciler().setMaterializationReceiptOwners(referencedEntries);
}

export function appendPendingUntitled(entry: PendingUntitled): void {
  getUntitledReconciler().append(entry);
  // The new tab is opened before this append. Flush after the reconciler has
  // made it eligible for desk persistence so a same-tick reload cannot lose it.
}

export function isUntitledPending(projectId: string, documentId: string): boolean {
  return getUntitledReconciler().has(projectId, documentId);
}

export function useUntitledPending(projectId: string, documentId: string): boolean {
  const reconciler = typeof window === "undefined" ? null : getUntitledReconciler();
  return useSyncExternalStore(
    reconciler?.subscribe ?? noopSubscribe,
    () => reconciler?.has(projectId, documentId) ?? false,
    () => false,
  );
}

export function useUntitledPendingSince(projectId: string, documentId: string): number | null {
  const reconciler = typeof window === "undefined" ? null : getUntitledReconciler();
  return useSyncExternalStore(
    reconciler?.subscribe ?? noopSubscribe,
    () => reconciler?.pendingSince(projectId, documentId) ?? null,
    () => null,
  );
}

export function useQueuedIdentityFailure(
  projectId: string,
  documentId: string,
): QueuedIdentityFailure | null {
  const reconciler = typeof window === "undefined" ? null : getUntitledReconciler();
  return useSyncExternalStore(
    reconciler?.subscribe ?? noopSubscribe,
    () => reconciler?.queuedIdentityFailure(projectId, documentId) ?? null,
    () => null,
  );
}

export function clearQueuedIdentityFailure(projectId: string, documentId: string): void {
  getUntitledReconciler().clearQueuedIdentityFailure(projectId, documentId);
}

export function queueUntitledIdentity(entry: PendingUntitled, desired: DesiredIdentity): void {
  getUntitledReconciler().queueIdentity(entry, desired);
}
