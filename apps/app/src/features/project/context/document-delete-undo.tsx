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

type DeleteOperationState = "pending" | "landed" | "refused" | "settled-locally";

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
  const emptyFolderChecks = useRef(new Set<string>());
  const emptyFolderRetryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [emptyFolderCheckRevision, retryEmptyFolderChecks] = useState(0);
  const restores = useRef(new Set<string>());
  const lifetime = useRef(new AbortController());
  const noticesRef = useRef(noticesBySurface);
  noticesRef.current = noticesBySurface;

  const dismiss = useCallback((operationId: string) => {
    emptyFolderChecks.current.delete(operationId);
    const timer = emptyFolderRetryTimers.current.get(operationId);
    if (timer) clearTimeout(timer);
    emptyFolderRetryTimers.current.delete(operationId);
    setNoticesBySurface((current) => {
      const surface = [...current].find(([, notice]) => notice.operationId === operationId)?.[0];
      if (!surface) return current;
      const next = new Map(current);
      next.delete(surface);
      return next;
    });
  }, []);

  useEffect(() => {
    // React Strict Mode replays effects during development. Allocate the
    // controller in the effect so that replay cleanup cannot poison the
    // controller used by the live provider instance.
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      for (const timer of emptyFolderRetryTimers.current.values()) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    for (const [surface, window] of noticesBySurface) {
      const operationId = window.operationId;
      const state = deleteOperationState(deleteIntents, operationId);
      if (state === "refused" || state === "settled-locally") dismiss(operationId);
      if (
        window.kind !== "folder" ||
        state !== "landed" ||
        emptyFolderChecks.current.has(operationId)
      )
        continue;
      emptyFolderChecks.current.add(operationId);
      void readDeleteRemovals(projectId, operationId, lifetime.current.signal)
        .then((removed) => {
          if (removed?.length === 0) dismiss(operationId);
        })
        .catch(() => {
          if (
            lifetime.current.signal.aborted ||
            noticesRef.current.get(surface)?.operationId !== operationId
          )
            return;
          const prior = emptyFolderRetryTimers.current.get(operationId);
          if (prior) clearTimeout(prior);
          emptyFolderRetryTimers.current.set(
            operationId,
            setTimeout(() => {
              emptyFolderChecks.current.delete(operationId);
              emptyFolderRetryTimers.current.delete(operationId);
              if (
                lifetime.current.signal.aborted ||
                noticesRef.current.get(surface)?.operationId !== operationId
              )
                return;
              retryEmptyFolderChecks((revision) => revision + 1);
            }, 1_000),
          );
        });
    }
  }, [deleteIntents, dismiss, emptyFolderCheckRevision, noticesBySurface, projectId]);

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
            const previous = current.get(surface);
            if (previous) {
              emptyFolderChecks.current.delete(previous.operationId);
              const timer = emptyFolderRetryTimers.current.get(previous.operationId);
              if (timer) clearTimeout(timer);
              emptyFolderRetryTimers.current.delete(previous.operationId);
            }
            return new Map(current).set(surface, { ...window, operationId, surface });
          });
        } catch {
          settleMark("kept");
          announceError(t`Couldn't delete ${target.name}. Try again.`);
        }
      })();
    },
    [notices, projectId, resources],
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

  const waitForSettlement = useCallback(
    (operationId: string) =>
      new Promise<DeleteOperationState>((resolve, reject) => {
        let stop: (() => void) | null = null;
        let done = false;
        function finish(state: DeleteOperationState) {
          if (done) return;
          done = true;
          lifetime.current.signal.removeEventListener("abort", abort);
          stop?.();
          resolve(state);
        }
        function fail(error: unknown) {
          if (done) return;
          done = true;
          lifetime.current.signal.removeEventListener("abort", abort);
          stop?.();
          reject(error);
        }
        function abort() {
          finish("refused");
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
          stop?.();
          return;
        }
        lifetime.current.signal.addEventListener("abort", abort, { once: true });
        if (lifetime.current.signal.aborted) abort();
      }),
    [projectId, resources],
  );

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
          const state = await waitForSettlement(operationId);
          if (state === "refused" || state === "settled-locally") {
            dismiss(operationId);
            return;
          }
          if (state !== "landed") throw new Error("Delete settlement is unavailable");
          const documents = await readDeleteRemovals(
            projectId,
            operationId,
            lifetime.current.signal,
          );
          if (!documents) throw new Error("Delete receipt is unavailable");
          if (documents.length === 0) {
            dismiss(operationId);
            return;
          }
          const response = await restoreContextDocuments(
            projectId,
            { documents },
            {
              signal: lifetime.current.signal,
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
          if (lifetime.current.signal.aborted) return;
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
    [dismiss, noticesBySurface, projectId, updateFeedback, waitForSettlement],
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
