/** Project-scoped delete notices and their replica-derived Undo lifecycle. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { NamespaceIntent, ResourceProjectionSnapshot } from "@meridian/resource-replica";
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
import { announce, announceError, getContextTabs } from "@/client/stores";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { documentLocationName } from "../../chat/document-display-name";
import { useDockDocumentStore } from "../dock/dock-document-store";
import { SurfaceNotice, type SurfaceNoticeModel } from "../shell/SurfaceNotice";
import {
  useAccountResourceProjection,
  useAccountResourceReplica,
  useOptionalRemovedNotices,
} from "./account-feature-context";
import type { DeleteTarget } from "./ContextEntryActions";

export type DeleteNoticeSurface = "sidebar" | "work-files" | "mobile" | "chat-files";

type RestoreFeedback =
  | { kind: "restoring" }
  | { kind: "failed"; message: string; retryable: boolean };

type DeleteWindow = {
  label: string;
  kind: "file" | "folder";
  settlement?: SettledDeleteOperationState;
  feedback?: RestoreFeedback;
};

type PresentedDeleteWindow = DeleteWindow & {
  operationId: string;
  surface: DeleteNoticeSurface;
};

type DeleteOperationState = "pending" | "landed" | "refused" | "settled-locally";
type SettledDeleteOperationState = Exclude<DeleteOperationState, "pending">;

type ProviderLifetime = {
  controller: AbortController;
  mounted: boolean;
};

type DeleteUndoContextValue = {
  notices: readonly PresentedDeleteWindow[];
  requestDelete: (target: DeleteTarget, surface: DeleteNoticeSurface) => void;
  undo: (operationId: string) => void;
  dismiss: (operationId: string) => void;
};

const DeleteUndoContext = createContext<DeleteUndoContextValue | null>(null);

function deleteOperationIndex(
  snapshot: ResourceProjectionSnapshot | null,
): ReadonlyMap<string, NamespaceIntent> {
  const index = new Map<string, NamespaceIntent>();
  if (!snapshot) return index;
  for (const intent of [
    ...snapshot.records.flatMap((record) => record.intents),
    ...snapshot.folders.flatMap((folder) => folder.intents),
  ]) {
    if (intent.operationId && intent.desired.kind === "delete")
      index.set(intent.operationId, intent);
  }
  return index;
}

function deleteOperationState(
  intents: ReadonlyMap<string, NamespaceIntent>,
  operationId: string,
): DeleteOperationState {
  const intent = intents.get(operationId);
  switch (intent?.state) {
    case "settled":
      return "landed";
    case "settled-locally":
      return "settled-locally";
    case "needs-repair":
    case "cancelled":
    case "superseded":
    case "unexecutable-after-terminal":
      return "refused";
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
  const { snapshot } = useAccountResourceProjection(projectId);
  const deleteIntents = useMemo(() => deleteOperationIndex(snapshot), [snapshot]);
  const [noticesBySurface, setNoticesBySurface] = useState<
    ReadonlyMap<DeleteNoticeSurface, PresentedDeleteWindow>
  >(() => new Map());
  const restores = useRef(new Set<string>());
  const lifetime = useRef<ProviderLifetime | null>(null);

  const dismiss = useCallback(
    (operationId: string) => {
      void queryClient.cancelQueries({
        queryKey: deleteOperationQueryKey(projectId, operationId),
      });
      setNoticesBySurface((current) => {
        const surface = [...current].find(([, notice]) => notice.operationId === operationId)?.[0];
        if (!surface) return current;
        const next = new Map(current);
        next.delete(surface);
        return next;
      });
    },
    [projectId, queryClient],
  );

  useEffect(() => {
    const owner: ProviderLifetime = { controller: new AbortController(), mounted: true };
    lifetime.current = owner;
    return () => {
      owner.mounted = false;
      owner.controller.abort();
      restores.current.clear();
      void queryClient.cancelQueries({ queryKey: deleteOperationProjectKey(projectId) });
      if (lifetime.current === owner) lifetime.current = null;
    };
  }, [projectId, queryClient]);

  useEffect(() => {
    const active = new Set([...noticesBySurface.values()].map(({ operationId }) => operationId));
    void queryClient.cancelQueries({
      predicate: ({ queryKey, state }) =>
        state.fetchStatus === "fetching" &&
        queryKey[0] === DELETE_OPERATION_QUERY_ROOT[0] &&
        queryKey[1] === projectId &&
        typeof queryKey[2] === "string" &&
        !active.has(queryKey[2]),
    });
    for (const window of noticesBySurface.values()) {
      const operationId = window.operationId;
      const state = deleteOperationState(deleteIntents, operationId);
      if (state === "refused" || state === "settled-locally") dismiss(operationId);
    }
  }, [deleteIntents, dismiss, noticesBySurface, projectId, queryClient]);

  const updateSettlement = useCallback(
    (operationId: string, settlement: SettledDeleteOperationState) => {
      setNoticesBySurface((current) => {
        const surface = [...current].find(([, notice]) => notice.operationId === operationId)?.[0];
        if (!surface) return current;
        const window = current.get(surface);
        if (!window) return current;
        return new Map(current).set(surface, { ...window, settlement });
      });
    },
    [],
  );

  const requestDelete = useCallback(
    (target: DeleteTarget, surface: DeleteNoticeSurface) => {
      const owner = lifetime.current;
      if (!owner) return;
      const settleMark =
        notices?.markOwnRemoval(projectId, ownDeletedDocumentIds(projectId, target)) ??
        (() => undefined);
      void (async () => {
        try {
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
          };
          setNoticesBySurface((current) => {
            return new Map(current).set(surface, { ...window, operationId, surface });
          });
          if (window.kind === "folder") {
            void resolveDeleteSettlement(queryClient, resources, projectId, operationId)
              .then(async (state) => {
                if (!isActive(owner)) return;
                updateSettlement(operationId, state);
                if (state === "refused" || state === "settled-locally") {
                  dismiss(operationId);
                  return;
                }
                const documents = await resolveDeleteReceipt(queryClient, projectId, operationId);
                if (isActive(owner) && documents.length === 0) dismiss(operationId);
              })
              .catch(() => undefined);
          }
        } catch {
          settleMark("kept");
          if (!isActive(owner)) return;
          announceError(t`Couldn't delete ${target.name}. Try again.`);
        }
      })();
    },
    [dismiss, notices, projectId, queryClient, resources, updateSettlement],
  );

  const updateFeedback = useCallback((operationId: string, feedback: RestoreFeedback) => {
    setNoticesBySurface((current) => {
      const surface = [...current].find(([, notice]) => notice.operationId === operationId)?.[0];
      if (!surface) return current;
      const window = current.get(surface);
      if (!window) return current;
      return new Map(current).set(surface, { ...window, feedback });
    });
  }, []);

  const undo = useCallback(
    (operationId: string) => {
      const owner = lifetime.current;
      const window = [...noticesBySurface.values()].find(
        (notice) => notice.operationId === operationId,
      );
      if (!owner || !window || restores.current.has(operationId)) return;
      restores.current.add(operationId);
      updateFeedback(operationId, { kind: "restoring" });
      void (async () => {
        try {
          const state =
            window.settlement ??
            (await resolveDeleteSettlement(queryClient, resources, projectId, operationId));
          if (!isActive(owner)) return;
          updateSettlement(operationId, state);
          if (state === "refused" || state === "settled-locally") {
            dismiss(operationId);
            return;
          }
          if (state !== "landed") throw new Error("Delete settlement is unavailable");
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
    [dismiss, noticesBySurface, projectId, queryClient, resources, updateFeedback],
  );

  const value = useMemo<DeleteUndoContextValue>(
    () => ({
      notices: [...noticesBySurface.values()],
      requestDelete,
      undo,
      dismiss,
    }),
    [dismiss, noticesBySurface, requestDelete, undo],
  );
  return <DeleteUndoContext.Provider value={value}>{children}</DeleteUndoContext.Provider>;
}

function useDocumentDeleteUndo(): DeleteUndoContextValue {
  const value = useContext(DeleteUndoContext);
  if (!value) throw new Error("DocumentDeleteUndoProvider is required");
  return value;
}

export function useDeleteContextEntry(surface: DeleteNoticeSurface = "sidebar") {
  const { requestDelete } = useDocumentDeleteUndo();
  return useMemo(
    () => ({ requestDelete: (target: DeleteTarget) => requestDelete(target, surface) }),
    [requestDelete, surface],
  );
}

export function DocumentDeleteUndoNotice({
  surface,
  className,
}: {
  surface: DeleteNoticeSurface;
  className?: string;
}) {
  const { notices, undo, dismiss } = useDocumentDeleteUndo();
  const notice = notices.find((candidate) => candidate.surface === surface);
  const model: SurfaceNoticeModel | null = notice
    ? {
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
      }
    : null;
  return <SurfaceNotice notice={model} className={className} />;
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

function deleteSettlementQuery(
  resources: Pick<AccountResourceReplica, "observeProjection">,
  projectId: string,
  operationId: string,
) {
  return queryOptions({
    queryKey: [...deleteOperationQueryKey(projectId, operationId), "settlement"],
    queryFn: ({ signal }) => waitForDeleteSettlement(resources, projectId, operationId, signal),
    retry: 2,
    staleTime: Number.POSITIVE_INFINITY,
  });
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

async function resolveDeleteSettlement(
  queryClient: QueryClient,
  resources: Pick<AccountResourceReplica, "observeProjection">,
  projectId: string,
  operationId: string,
): Promise<SettledDeleteOperationState> {
  const settlement = deleteSettlementQuery(resources, projectId, operationId);
  try {
    return await queryClient.fetchQuery(settlement);
  } catch (error) {
    queryClient.removeQueries({ queryKey: settlement.queryKey, exact: true });
    throw error;
  }
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

function waitForDeleteSettlement(
  resources: Pick<AccountResourceReplica, "observeProjection">,
  projectId: string,
  operationId: string,
  signal: AbortSignal,
): Promise<SettledDeleteOperationState> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | null = null;
    let done = false;
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      stop?.();
      stop = null;
    };
    function finish(state: SettledDeleteOperationState) {
      if (done) return;
      done = true;
      cleanup();
      resolve(state);
    }
    function fail(error: unknown) {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    }
    function abort() {
      fail(signal.reason);
    }
    try {
      stop = resources.observeProjection(
        projectId,
        (current) => {
          const state = deleteOperationState(deleteOperationIndex(current), operationId);
          if (state !== "pending") finish(state);
        },
        fail,
      );
    } catch (error) {
      fail(error);
    }
    if (done) {
      cleanup();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function isActive(owner: ProviderLifetime): boolean {
  return owner.mounted && !owner.controller.signal.aborted;
}
