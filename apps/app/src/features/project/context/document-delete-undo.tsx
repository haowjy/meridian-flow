/** Project-scoped delete notices and their replica-derived Undo lifecycle. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { NamespaceIntent, ResourceProjectionSnapshot } from "@meridian/resource-replica";
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
  feedback?: RestoreFeedback;
};

type PresentedDeleteWindow = DeleteWindow & {
  operationId: string;
  surface: DeleteNoticeSurface;
};

type DeleteOperationState = "pending" | "landed" | "refused" | "settled-locally" | "aborted";

type DeleteReceiptResolution = {
  state: DeleteOperationState;
  documents: Awaited<ReturnType<typeof readDeleteRemovals>>;
};

type DeleteReceiptTask = {
  controller: AbortController;
  promise: Promise<DeleteReceiptResolution>;
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
  const { snapshot } = useAccountResourceProjection(projectId);
  const deleteIntents = useMemo(() => deleteOperationIndex(snapshot), [snapshot]);
  const [noticesBySurface, setNoticesBySurface] = useState<
    ReadonlyMap<DeleteNoticeSurface, PresentedDeleteWindow>
  >(() => new Map());
  const receiptTasks = useRef(new Map<string, DeleteReceiptTask>());
  const restores = useRef(new Set<string>());
  const mounted = useRef(true);

  const cancelReceiptTask = useCallback((operationId: string) => {
    receiptTasks.current.get(operationId)?.controller.abort();
    receiptTasks.current.delete(operationId);
  }, []);

  const dismiss = useCallback(
    (operationId: string) => {
      cancelReceiptTask(operationId);
      setNoticesBySurface((current) => {
        const surface = [...current].find(([, notice]) => notice.operationId === operationId)?.[0];
        if (!surface) return current;
        const next = new Map(current);
        next.delete(surface);
        return next;
      });
    },
    [cancelReceiptTask],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const task of receiptTasks.current.values()) task.controller.abort();
      receiptTasks.current.clear();
    };
  }, []);

  const receiptTask = useCallback(
    (operationId: string) => {
      const existing = receiptTasks.current.get(operationId);
      if (existing) return existing;
      const controller = new AbortController();
      const promise = resolveDeleteReceipt(resources, projectId, operationId, controller.signal);
      const task = { controller, promise };
      receiptTasks.current.set(operationId, task);
      return task;
    },
    [projectId, resources],
  );

  useEffect(() => {
    const active = new Set([...noticesBySurface.values()].map(({ operationId }) => operationId));
    for (const operationId of receiptTasks.current.keys()) {
      if (!active.has(operationId)) cancelReceiptTask(operationId);
    }
    for (const window of noticesBySurface.values()) {
      const operationId = window.operationId;
      const state = deleteOperationState(deleteIntents, operationId);
      if (state === "refused" || state === "settled-locally") dismiss(operationId);
    }
  }, [cancelReceiptTask, deleteIntents, dismiss, noticesBySurface]);

  const requestDelete = useCallback(
    (target: DeleteTarget, surface: DeleteNoticeSurface) => {
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
          if (!operationId) return;
          const window: DeleteWindow = {
            label: target.name,
            kind: target.kind === "file" ? "file" : "folder",
          };
          setNoticesBySurface((current) => {
            return new Map(current).set(surface, { ...window, operationId, surface });
          });
          const task = receiptTask(operationId);
          if (window.kind === "folder")
            void task.promise
              .then(({ state, documents }) => {
                if (state === "landed" && documents?.length === 0) dismiss(operationId);
              })
              .catch(() => undefined);
        } catch {
          settleMark("kept");
          announceError(t`Couldn't delete ${target.name}. Try again.`);
        }
      })();
    },
    [dismiss, notices, projectId, receiptTask, resources],
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
      const window = [...noticesBySurface.values()].find(
        (notice) => notice.operationId === operationId,
      );
      if (!window || restores.current.has(operationId)) return;
      restores.current.add(operationId);
      updateFeedback(operationId, { kind: "restoring" });
      void (async () => {
        try {
          const task = receiptTask(operationId);
          const { state, documents } = await task.promise;
          if (state === "refused" || state === "settled-locally") {
            dismiss(operationId);
            return;
          }
          if (state === "aborted") throw new Error("Delete settlement was interrupted");
          if (state !== "landed") throw new Error("Delete settlement is unavailable");
          if (!documents) throw new Error("Delete receipt is unavailable");
          if (documents.length === 0) {
            dismiss(operationId);
            return;
          }
          const response = await restoreContextDocuments(
            projectId,
            { documents },
            {
              signal: task.controller.signal,
            },
          );
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
          if (!mounted.current) return;
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
    [dismiss, noticesBySurface, projectId, receiptTask, updateFeedback],
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

async function resolveDeleteReceipt(
  resources: Pick<AccountResourceReplica, "observeProjection">,
  projectId: string,
  operationId: string,
  signal: AbortSignal,
): Promise<DeleteReceiptResolution> {
  const state = await waitForDeleteSettlement(resources, projectId, operationId, signal);
  return {
    state,
    documents: state === "landed" ? await retryReceiptRead(projectId, operationId, signal) : null,
  };
}

function waitForDeleteSettlement(
  resources: Pick<AccountResourceReplica, "observeProjection">,
  projectId: string,
  operationId: string,
  signal: AbortSignal,
): Promise<DeleteOperationState> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | null = null;
    let done = false;
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      stop?.();
      stop = null;
    };
    function finish(state: DeleteOperationState) {
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
      finish("aborted");
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

async function retryReceiptRead(projectId: string, operationId: string, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      return await readDeleteRemovals(projectId, operationId, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      await abortableDelay(1_000, signal);
    }
  }
  throw signal.reason;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    function finish() {
      cleanup();
      resolve();
    }
    function abort() {
      cleanup();
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
