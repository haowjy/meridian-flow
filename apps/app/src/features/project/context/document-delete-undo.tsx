/** Project-scoped delete notices and their replica-derived Undo lifecycle. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  type NamespaceIntent,
  type ParentRef,
  placementTakenSince,
  type ResourceProjectionSnapshot,
  resourceIdentityIndex,
  resourcePlacementForSnapshot,
  resourceVisibleInProject,
} from "@meridian/resource-replica";
import { type QueryClient, queryOptions, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getContextOperationReceipt, restoreContextDocuments } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { announce, announceError, getContextTabs } from "@/client/stores";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { documentLocationName } from "../../chat/document-display-name";
import { useDockDocumentStore } from "../dock/dock-document-store";
import {
  NoticePlacement,
  type NoticeSurface,
  SurfaceNotice,
  useNoticeSlot,
} from "../shell/SurfaceNotice";
import {
  useAccountResourceProjection,
  useAccountResourceReplica,
  useOptionalRemovedNotices,
} from "./account-feature-context";
import type { DeleteTarget } from "./ContextEntryActions";
import { moveRows, type NamingView } from "./entry-drag/execute-move";
import {
  positionFromWitness,
  type SiblingPositionWitness,
  sameParent,
  siblingPositionWitness,
} from "./entry-drag/move-plan";

type RestoreFeedback =
  | { kind: "restoring" }
  | { kind: "failed"; message: string; retryable: boolean };

type DeleteWindow = {
  label: string;
  kind: "file" | "folder";
  restorePlacement?: DeletedPlacement;
  /** "restoring" from the Undo click: the restore runs once the replica shows the delete landed. */
  feedback?: RestoreFeedback;
};

type PresentedDeleteWindow = DeleteWindow & {
  operationId: string;
  surface: NoticeSurface;
  /** False once a newer notice took its surface while its restore still runs. */
  shown: boolean;
};

/**
 * `local`: settled on this device because the server never held the entry, and its content and
 * place still wait out the Undo window. `closed`: refused, superseded (an Undo included), or expired.
 */
type DeleteOperationState = "pending" | "landed" | "local" | "closed";

type DeleteOperation = { intent: NamespaceIntent; restorable: boolean; notBefore?: number };

type ProviderLifetime = {
  controller: AbortController;
  mounted: boolean;
};

type DeleteUndoContextValue = {
  notices: readonly PresentedDeleteWindow[];
  requestDelete: (target: DeleteTarget, surface: NoticeSurface) => void;
  undo: (operationId: string) => void;
  dismiss: (operationId: string) => void;
  restoredElsewhere: (documents: readonly RemovedDocument[]) => void;
};

type RemovedDocument = { documentId: string; removal: { locationVersion: string } };

type DeletedPlacement = {
  documentId: string;
  parent: ParentRef;
  position: SiblingPositionWitness;
};

/** One removal of one document; a later delete of the same document is a different removal. */
function removalKey({ documentId, removal }: RemovedDocument): string {
  return `${documentId}@${removal.locationVersion}`;
}

const DeleteUndoContext = createContext<DeleteUndoContextValue | null>(null);

function deleteOperationIndex(
  snapshot: ResourceProjectionSnapshot | null,
  now: number,
): ReadonlyMap<string, DeleteOperation> {
  const index = new Map<string, DeleteOperation>();
  if (!snapshot) return index;
  const add = (operation: DeleteOperation) => {
    const operationId = operation.intent.operationId;
    if (!operationId) return;
    const previous = index.get(operationId);
    index.set(operationId, {
      ...operation,
      // A local folder delete settles one operation over its subtree: one restorable child is
      // enough for the window's Undo to bring the whole subtree back.
      restorable: operation.restorable || Boolean(previous?.restorable),
      ...(previous?.notBefore !== undefined && operation.notBefore === undefined
        ? { notBefore: previous.notBefore }
        : {}),
    });
  };
  for (const record of snapshot.records) {
    for (const intent of record.intents) {
      if (!intent.operationId || intent.desired.kind !== "delete") continue;
      const cleanup = record.resource.obligations.cleanup;
      const restorable =
        cleanup?.obligationId === intent.intentId &&
        (cleanup.notBefore === undefined || cleanup.notBefore > now);
      add({
        intent,
        restorable,
        ...(cleanup?.notBefore !== undefined ? { notBefore: cleanup.notBefore } : {}),
      });
    }
  }
  for (const folder of snapshot.folders) {
    for (const intent of folder.intents) {
      if (!intent.operationId || intent.desired.kind !== "delete") continue;
      const window = folder.localDeletion;
      const restorable = window?.obligationId === intent.intentId && window.notBefore > now;
      add({ intent, restorable, ...(window ? { notBefore: window.notBefore } : {}) });
    }
  }
  return index;
}

function deleteOperationState(
  operations: ReadonlyMap<string, DeleteOperation>,
  operationId: string,
): DeleteOperationState {
  const operation = operations.get(operationId);
  switch (operation?.intent.state) {
    case "settled":
      return "landed";
    case "settled-locally":
      return operation.restorable ? "local" : "closed";
    case "needs-repair":
    case "cancelled":
    case "superseded":
    case "unexecutable-after-terminal":
      return "closed";
    default:
      return "pending";
  }
}

function ownDeletedDocumentIds(projectId: string, target: DeleteTarget): string[] {
  if (target.kind === "file") return [target.documentId];
  const folder = `${target.path.replace(/^\/+|\/+$/g, "")}/`;
  const dock = useDockDocumentStore.getState().occupant;
  const presented = [
    ...getContextTabs(projectId).tabs,
    ...(dock?.projectId === projectId ? [dock.tab] : []),
  ];
  return presented.flatMap((tab) =>
    tab.kind !== "new" &&
    tab.scheme === target.scheme &&
    (target.scheme !== "scratch" ||
      ((target.owner.workId == null || tab.workId === target.owner.workId) &&
        tab.rootThreadId === target.owner.rootThreadId)) &&
    tab.path.replace(/^\/+/, "").startsWith(folder)
      ? [tab.documentId]
      : [],
  );
}

async function captureDeletedPlacement(
  resources: AccountResourceReplica,
  projectId: string,
  target: DeleteTarget,
): Promise<DeletedPlacement | undefined> {
  if (target.kind !== "file") return undefined;
  const snapshot = await resources.readProjection(projectId);
  const placement = resourcePlacementForSnapshot(projectId, snapshot);
  const record = resourceIdentityIndex(snapshot.records).byDocumentId(target.documentId);
  const parent = record ? placement.parentForResource(record) : null;
  return record && parent
    ? {
        documentId: target.documentId,
        parent,
        position: siblingPositionWitness(
          { records: snapshot.records, placement },
          parent,
          target.documentId,
        ),
      }
    : undefined;
}

function restoredFileView(
  snapshot: ResourceProjectionSnapshot,
  projectId: string,
  documentId: string,
): { name: string; parent: ParentRef; view: NamingView } | null {
  const record = resourceIdentityIndex(snapshot.records).byDocumentId(documentId);
  if (!record || !resourceVisibleInProject(projectId, record, snapshot.catalogs)) return null;
  const placement = resourcePlacementForSnapshot(projectId, snapshot);
  const location = placement.resourceLocation(record);
  const parent = placement.parentForResource(record);
  return location && parent
    ? {
        name: location.name,
        parent,
        view: { records: snapshot.records, folders: snapshot.folders, placement },
      }
    : null;
}

async function waitForRestoredFile(
  resources: AccountResourceReplica,
  projectId: string,
  documentId: string,
  signal: AbortSignal,
) {
  const current = restoredFileView(
    await resources.readProjection(projectId),
    projectId,
    documentId,
  );
  if (current) return current;
  if (signal.aborted) throw signal.reason;
  return new Promise<NonNullable<ReturnType<typeof restoredFileView>>>((resolve, reject) => {
    const stop = resources.observeProjection(
      projectId,
      (snapshot) => {
        const restored = restoredFileView(snapshot, projectId, documentId);
        if (!restored) return;
        cleanup();
        resolve(restored);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    function cleanup() {
      signal.removeEventListener("abort", abort);
      stop();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function restoreDeletedPosition(
  resources: AccountResourceReplica,
  projectId: string,
  deleted: DeletedPlacement,
  deleteOperationId: string,
  signal: AbortSignal,
): Promise<void> {
  const restored = await waitForRestoredFile(resources, projectId, deleted.documentId, signal);
  if (!sameParent(restored.parent, deleted.parent)) return;
  // Seeing the row again does not mean the restoration still owns it: a placement the writer
  // admitted after the delete is newer than the position this Undo would put back.
  const journal = resourceIdentityIndex(restored.view.records).byDocumentId(deleted.documentId);
  const deletion = journal?.intents.find((intent) => intent.operationId === deleteOperationId);
  if (journal && deletion && placementTakenSince(journal.intents, deletion)) return;
  const siblings = restored.view.placement
    .childrenAt(deleted.parent, restored.view.records)
    .map((entry) => entry.entryId)
    .filter((entryId) => entryId !== deleted.documentId);
  const result = await moveRows(
    [
      {
        entry: { kind: "file", id: deleted.documentId },
        name: restored.name,
        before: restored.parent,
        after: deleted.parent,
        position: positionFromWitness(deleted.position, siblings),
      },
    ],
    { resources, projectId },
    restored.view,
  );
  if (result.failed.length > 0) throw new Error("Restored document position was refused");
}

export function DocumentDeleteUndoProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const resources = useAccountResourceReplica();
  const notices = useOptionalRemovedNotices();
  const queryClient = useQueryClient();
  const slots = useNoticeSlot();
  const { snapshot } = useAccountResourceProjection(projectId);
  // The local Undo window is time-bounded, so the index is read against a clock that the
  // nearest expiry wakes; otherwise a closed window would keep its notice until a replica change.
  const [clock, setClock] = useState(0);
  const deleteOperations = useMemo(
    () => deleteOperationIndex(snapshot, Date.now()),
    [snapshot, clock],
  );
  useEffect(() => {
    const expiries = [...deleteOperations.values()].flatMap((operation) =>
      operation.notBefore === undefined ? [] : [operation.notBefore],
    );
    if (expiries.length === 0) return;
    const next = Math.min(...expiries);
    const timer = setTimeout(
      () => setClock((current) => current + 1),
      Math.max(0, next - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [deleteOperations]);
  // By operation: a notice replaced on its surface while its Undo runs stays here, unshown,
  // until the restore finishes.
  const [windows, setWindows] = useState<ReadonlyMap<string, PresentedDeleteWindow>>(
    () => new Map(),
  );
  const restores = useRef(new Set<string>());
  const folderChecks = useRef(new Set<string>());
  // Removals brought back outside Undo (from Trash), kept while any notice could hold them.
  const [restored, setRestored] = useState<ReadonlySet<string>>(() => new Set());
  const lifetime = useRef<ProviderLifetime | null>(null);
  const windowsRef = useRef(windows);
  windowsRef.current = windows;

  const dismiss = useCallback(
    (operationId: string) => {
      void queryClient.cancelQueries({
        queryKey: deleteOperationQueryKey(projectId, operationId),
      });
      setWindows((current) => {
        if (!current.has(operationId)) return current;
        const next = new Map(current);
        next.delete(operationId);
        return next;
      });
    },
    [projectId, queryClient],
  );

  /** A newer notice took the surface: close this one, unless its Undo is already running. */
  const release = useCallback((operationId: string) => {
    setWindows((current) => {
      const window = current.get(operationId);
      if (!window) return current;
      const next = new Map(current);
      if (window.feedback?.kind === "restoring") next.set(operationId, { ...window, shown: false });
      else next.delete(operationId);
      return next;
    });
  }, []);

  useEffect(() => {
    const owner: ProviderLifetime = { controller: new AbortController(), mounted: true };
    lifetime.current = owner;
    return () => {
      owner.mounted = false;
      owner.controller.abort();
      restores.current.clear();
      folderChecks.current.clear();
      void queryClient.cancelQueries({ queryKey: deleteOperationProjectKey(projectId) });
      if (lifetime.current === owner) lifetime.current = null;
    };
  }, [projectId, queryClient]);

  useEffect(() => {
    const active = new Set([...windows.values()].map(({ operationId }) => operationId));
    void queryClient.cancelQueries({
      predicate: ({ queryKey, state }) =>
        state.fetchStatus === "fetching" &&
        queryKey[0] === DELETE_OPERATION_QUERY_ROOT[0] &&
        queryKey[1] === projectId &&
        typeof queryKey[2] === "string" &&
        !active.has(queryKey[2]),
    });
  }, [windows, projectId, queryClient]);

  const requestDelete = useCallback(
    (target: DeleteTarget, surface: NoticeSurface) => {
      const owner = lifetime.current;
      if (!owner) return;
      const settleMark =
        notices?.markOwnRemoval(projectId, ownDeletedDocumentIds(projectId, target)) ??
        (() => undefined);
      void (async () => {
        try {
          const restorePlacement = await captureDeletedPlacement(resources, projectId, target);
          const result =
            target.kind === "file"
              ? await (async () => {
                  const key = await resources.keyForDocument(projectId, target.documentId);
                  if (!key) throw new Error("Document resource is unavailable");
                  return resources.deleteDocument(projectId, key);
                })()
              : await resources.deleteFolder(projectId, target.entryId);
          settleMark("removed");
          const { operationId } = result;
          if (!operationId || !isActive(owner)) return;
          const window: DeleteWindow = {
            label: target.name,
            kind: target.kind === "file" ? "file" : "folder",
            ...(restorePlacement ? { restorePlacement } : {}),
          };
          setWindows((current) =>
            new Map(current).set(operationId, { ...window, operationId, surface, shown: true }),
          );
          slots.take(surface, () => release(operationId));
        } catch {
          settleMark("kept");
          if (!isActive(owner)) return;
          announceError(t`Couldn't delete ${target.name}. Try again.`);
        }
      })();
    },
    [notices, projectId, release, resources, slots],
  );

  const updateFeedback = useCallback((operationId: string, feedback: RestoreFeedback) => {
    setWindows((current) => {
      const window = current.get(operationId);
      if (!window) return current;
      const next = new Map(current);
      // An unshown notice has no card to fail on; the newer notice keeps its place.
      if (!window.shown && feedback.kind === "failed") next.delete(operationId);
      else next.set(operationId, { ...window, feedback });
      return next;
    });
    const window = windowsRef.current.get(operationId);
    if (window && !window.shown && feedback.kind === "failed") announceError(feedback.message);
  }, []);

  const undo = useCallback(
    (operationId: string) => updateFeedback(operationId, { kind: "restoring" }),
    [updateFeedback],
  );

  const runRestore = useCallback(
    (window: PresentedDeleteWindow, owner: ProviderLifetime) => {
      const { operationId } = window;
      restores.current.add(operationId);
      void (async () => {
        try {
          const documents = await resolveDeleteReceipt(queryClient, projectId, operationId);
          if (!isActive(owner)) return;
          if (documents.length === 0) {
            dismiss(operationId);
            return;
          }
          const response = await restoreContextDocuments(
            projectId,
            { documents },
            {
              signal: owner.controller.signal,
            },
          );
          if (!isActive(owner)) return;
          const fault = response.documents.find(
            (result) => result.outcome === "ancestor_taken" || result.outcome === "refused",
          );
          if (fault) {
            updateFeedback(operationId, {
              kind: "failed",
              retryable: fault.outcome === "ancestor_taken",
              message:
                fault.outcome === "ancestor_taken"
                  ? t`Couldn't restore ${window.label}. A file is in the way.`
                  : t`Couldn't restore ${window.label}.`,
            });
            return;
          }
          const placementResult = window.restorePlacement
            ? response.documents.find(
                (result) => result.documentId === window.restorePlacement?.documentId,
              )
            : undefined;
          if (
            window.restorePlacement &&
            (placementResult?.outcome === "restored" ||
              placementResult?.outcome === "already_living")
          )
            await restoreDeletedPosition(
              resources,
              projectId,
              window.restorePlacement,
              operationId,
              owner.controller.signal,
            );
          if (
            response.documents.some(
              (result) => result.outcome === "superseded" || result.outcome === "already_living",
            )
          ) {
            dismiss(operationId);
            return;
          }
          const alternateLocations = response.documents.flatMap((result) =>
            result.outcome === "restored" && result.landedAt
              ? [documentLocationName(result.landedAt)]
              : [],
          );
          if (alternateLocations.length > 0)
            announce(t`Restored at ${alternateLocations.join(", ")}.`);
          void queryClient.invalidateQueries({
            queryKey: projectQueryKeys.documentTrash(projectId),
          });
          dismiss(operationId);
        } catch {
          if (!isActive(owner)) return;
          updateFeedback(operationId, {
            kind: "failed",
            retryable: true,
            message: t`Couldn't restore ${window.label}. Try again.`,
          });
        } finally {
          restores.current.delete(operationId);
        }
      })();
    },
    [dismiss, projectId, queryClient, resources, updateFeedback],
  );

  /** An entry only this device held comes back from the replica itself; there is no Trash to read. */
  const runLocalRestore = useCallback(
    (window: PresentedDeleteWindow, owner: ProviderLifetime) => {
      const { operationId } = window;
      restores.current.add(operationId);
      void (async () => {
        try {
          // On success the superseded deletion closes the notice through the replica.
          if (await resources.restoreLocalDeletion(projectId, operationId)) return;
          if (!isActive(owner)) return;
          updateFeedback(operationId, {
            kind: "failed",
            retryable: false,
            message: t`Couldn't restore ${window.label}.`,
          });
        } catch {
          if (!isActive(owner)) return;
          updateFeedback(operationId, {
            kind: "failed",
            retryable: true,
            message: t`Couldn't restore ${window.label}. Try again.`,
          });
        } finally {
          restores.current.delete(operationId);
        }
      })();
    },
    [projectId, resources, updateFeedback],
  );

  // Delete progress is read from the replica, never copied: a refused delete closes its notice,
  // a requested Undo restores once its delete has landed (or, for an entry only this device
  // held, at once while its content and place are kept), and a landed
  // delete whose removals are all back (an empty folder, or restored from Trash) has
  // nothing left for Undo. That check reruns on every replica change, so a receipt that
  // failed to load is read again rather than leaving Undo offered.
  useEffect(() => {
    const owner = lifetime.current;
    if (!owner) return;
    for (const window of windows.values()) {
      const { operationId } = window;
      const state = deleteOperationState(deleteOperations, operationId);
      if (state === "closed") {
        dismiss(operationId);
        continue;
      }
      if (state === "local") {
        if (window.feedback?.kind === "restoring" && !restores.current.has(operationId))
          runLocalRestore(window, owner);
        continue;
      }
      if (state !== "landed") continue;
      if (window.feedback?.kind === "restoring") {
        if (!restores.current.has(operationId)) runRestore(window, owner);
      } else if (
        restored.size > 0 ||
        (window.kind === "folder" && !folderChecks.current.has(operationId))
      ) {
        folderChecks.current.add(operationId);
        resolveDeleteReceipt(queryClient, projectId, operationId).then(
          (documents) => {
            if (!isActive(owner)) return;
            if (documents.every((document) => restored.has(removalKey(document))))
              dismiss(operationId);
          },
          () => undefined,
        );
      }
    }
  }, [
    deleteOperations,
    dismiss,
    windows,
    restored,
    projectId,
    queryClient,
    runRestore,
    runLocalRestore,
  ]);

  useEffect(() => {
    if (windows.size === 0 && restored.size > 0) setRestored(new Set());
  }, [windows, restored]);

  const restoredElsewhere = useCallback((documents: readonly RemovedDocument[]) => {
    setRestored((current) => {
      const next = new Set(current);
      for (const document of documents) next.add(removalKey(document));
      return next;
    });
  }, []);

  const value = useMemo<DeleteUndoContextValue>(
    () => ({
      notices: [...windows.values()].filter((window) => window.shown),
      requestDelete,
      undo,
      dismiss,
      restoredElsewhere,
    }),
    [dismiss, windows, requestDelete, undo, restoredElsewhere],
  );
  return <DeleteUndoContext.Provider value={value}>{children}</DeleteUndoContext.Provider>;
}

function useDocumentDeleteUndo(): DeleteUndoContextValue {
  const value = useContext(DeleteUndoContext);
  if (!value) throw new Error("DocumentDeleteUndoProvider is required");
  return value;
}

export function useDeleteContextEntry(surface: NoticeSurface = "sidebar") {
  const { requestDelete } = useDocumentDeleteUndo();
  return useMemo(
    () => ({ requestDelete: (target: DeleteTarget) => requestDelete(target, surface) }),
    [requestDelete, surface],
  );
}

/** Tells delete notices that these removals came back by another way than their Undo. */
export function useReportRestoredRemovals() {
  return useDocumentDeleteUndo().restoredElsewhere;
}

export function DocumentDeleteUndoNotice({
  surface,
  className,
}: {
  surface: NoticeSurface;
  className?: string;
}) {
  const { notices, undo, dismiss } = useDocumentDeleteUndo();
  const notice = notices.find((candidate) => candidate.surface === surface);
  if (!notice) return null;
  return (
    <NoticePlacement id={`delete:${notice.operationId}`}>
      <SurfaceNotice
        className={className}
        notice={{
          message:
            notice.feedback?.kind === "restoring" ? (
              <Trans>Restoring {notice.label}</Trans>
            ) : (
              <Trans>Deleted {notice.label}</Trans>
            ),
          undo:
            notice.feedback?.kind === "failed" && !notice.feedback.retryable
              ? null
              : () => undo(notice.operationId),
          dismiss: () => dismiss(notice.operationId),
          failure: notice.feedback?.kind === "failed" ? notice.feedback.message : undefined,
          undoing: notice.feedback?.kind === "restoring",
        }}
      />
    </NoticePlacement>
  );
}

/** The removals a landed delete recorded in its receipt; null while no successful delete receipt exists. */
async function readDeleteRemovals(projectId: string, operationId: string, signal: AbortSignal) {
  const receipt = await getContextOperationReceipt(projectId, operationId, { signal });
  if (!receipt?.result.ok) return null;
  const value = receipt.result.value;
  return "removed" in value ? value.removed : null;
}

const DELETE_OPERATION_QUERY_ROOT = ["context-delete"] as const;

function deleteOperationProjectKey(projectId: string) {
  return [...DELETE_OPERATION_QUERY_ROOT, projectId] as const;
}

function deleteOperationQueryKey(projectId: string, operationId: string) {
  return [...deleteOperationProjectKey(projectId), operationId] as const;
}

function deleteReceiptQuery(projectId: string, operationId: string) {
  return queryOptions({
    queryKey: [...deleteOperationQueryKey(projectId, operationId), "receipt"],
    queryFn: async ({ signal }) => {
      const documents = await readDeleteRemovals(projectId, operationId, signal);
      if (!documents) throw new Error("Delete receipt is unavailable");
      return documents;
    },
    retry: 2,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

async function resolveDeleteReceipt(
  queryClient: QueryClient,
  projectId: string,
  operationId: string,
) {
  const receipt = deleteReceiptQuery(projectId, operationId);
  try {
    return await queryClient.fetchQuery(receipt);
  } catch (error) {
    queryClient.removeQueries({ queryKey: receipt.queryKey, exact: true });
    throw error;
  }
}

function isActive(owner: ProviderLifetime): boolean {
  return owner.mounted && !owner.controller.signal.aborted;
}
