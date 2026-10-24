/** Project-scoped writer delete windows and their replica-derived Undo lifecycle. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { NamespaceIntent, ResourceProjectionSnapshot } from "@meridian/resource-replica";
import { X } from "lucide-react";
import {
  type CSSProperties,
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
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { documentLocationName } from "../../chat/document-display-name";
import { useDockDocumentStore } from "../dock/dock-document-store";
import {
  useAccountResourceProjection,
  useAccountResourceReplica,
  useOptionalRemovedNotices,
} from "./account-feature-context";
import type { DeleteTarget } from "./ContextEntryActions";

type DeleteScope = {
  scheme: ProjectContextTreeScheme;
  owner: { workId?: string; rootThreadId?: string };
};

type RestoreFeedback =
  | { kind: "restoring" }
  | { kind: "failed"; message: string; retryable: boolean };

type DeleteWindow = {
  label: string;
  kind: "file" | "folder";
  scope: DeleteScope;
  feedback?: RestoreFeedback;
};

type PresentedDeleteWindow = DeleteWindow & { operationId: string };

type DeleteOperationState = "pending" | "landed" | "refused" | "settled-locally";

type DeleteUndoContextValue = {
  windows: readonly PresentedDeleteWindow[];
  requestDelete: (target: DeleteTarget) => void;
  undo: (operationId: string) => void;
  dismiss: (operationId: string) => void;
};

const DeleteUndoContext = createContext<DeleteUndoContextValue | null>(null);

function normalizedScope(scheme: ProjectContextTreeScheme, owner: ContextOwner): DeleteScope {
  if (scheme !== "scratch") return { scheme, owner: {} };
  return {
    scheme,
    owner: {
      ...(owner.workId ? { workId: owner.workId } : {}),
      ...(owner.rootThreadId ? { rootThreadId: owner.rootThreadId } : {}),
    },
  };
}

function sameScope(left: DeleteScope, right: DeleteScope): boolean {
  return (
    left.scheme === right.scheme &&
    left.owner.workId === right.owner.workId &&
    left.owner.rootThreadId === right.owner.rootThreadId
  );
}

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
  const [windowsById, setWindowsById] = useState<ReadonlyMap<string, DeleteWindow>>(
    () => new Map(),
  );
  const emptyFolderChecks = useRef(new Set<string>());
  const emptyFolderRetryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [emptyFolderCheckRevision, retryEmptyFolderChecks] = useState(0);
  const restores = useRef(new Set<string>());
  const lifetime = useRef(new AbortController());
  const windowsRef = useRef(windowsById);
  windowsRef.current = windowsById;

  const dismiss = useCallback((operationId: string) => {
    emptyFolderChecks.current.delete(operationId);
    const timer = emptyFolderRetryTimers.current.get(operationId);
    if (timer) clearTimeout(timer);
    emptyFolderRetryTimers.current.delete(operationId);
    setWindowsById((current) => {
      if (!current.has(operationId)) return current;
      const next = new Map(current);
      next.delete(operationId);
      return next;
    });
  }, []);

  useEffect(
    () => () => {
      lifetime.current.abort();
      for (const timer of emptyFolderRetryTimers.current.values()) clearTimeout(timer);
    },
    [],
  );

  useEffect(() => {
    for (const [operationId, window] of windowsById) {
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
          if (lifetime.current.signal.aborted || !windowsRef.current.has(operationId)) return;
          const prior = emptyFolderRetryTimers.current.get(operationId);
          if (prior) clearTimeout(prior);
          emptyFolderRetryTimers.current.set(
            operationId,
            setTimeout(() => {
              emptyFolderChecks.current.delete(operationId);
              emptyFolderRetryTimers.current.delete(operationId);
              if (lifetime.current.signal.aborted || !windowsRef.current.has(operationId)) return;
              retryEmptyFolderChecks((revision) => revision + 1);
            }, 1_000),
          );
        });
    }
  }, [deleteIntents, dismiss, emptyFolderCheckRevision, projectId, windowsById]);

  const requestDelete = useCallback(
    (target: DeleteTarget) => {
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
            scope: normalizedScope(target.scheme, target.owner),
          };
          setWindowsById((current) => new Map(current).set(operationId, window));
        } catch {
          settleMark("kept");
          announceError(t`Couldn't delete ${target.name}. Try again.`);
        }
      })();
    },
    [notices, projectId, resources],
  );

  const updateFeedback = useCallback((operationId: string, feedback: RestoreFeedback) => {
    setWindowsById((current) => {
      const window = current.get(operationId);
      if (!window) return current;
      return new Map(current).set(operationId, { ...window, feedback });
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
      const window = windowsById.get(operationId);
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
    [dismiss, projectId, updateFeedback, waitForSettlement, windowsById],
  );

  const value = useMemo<DeleteUndoContextValue>(
    () => ({
      windows: [...windowsById].map(([operationId, window]) => ({ operationId, ...window })),
      requestDelete,
      undo,
      dismiss,
    }),
    [dismiss, requestDelete, undo, windowsById],
  );
  return <DeleteUndoContext.Provider value={value}>{children}</DeleteUndoContext.Provider>;
}

function useDocumentDeleteUndo(): DeleteUndoContextValue {
  const value = useContext(DeleteUndoContext);
  if (!value) throw new Error("DocumentDeleteUndoProvider is required");
  return value;
}

export function useDeleteContextEntry(): Pick<DeleteUndoContextValue, "requestDelete"> {
  const { requestDelete } = useDocumentDeleteUndo();
  return useMemo(() => ({ requestDelete }), [requestDelete]);
}

export function DocumentDeleteUndoRows({
  scheme,
  owner,
  className,
  style,
}: {
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  className?: string;
  style?: CSSProperties;
}) {
  const { windows, undo, dismiss } = useDocumentDeleteUndo();
  const scope = normalizedScope(scheme, owner);
  const visible = windows.filter((window) => sameScope(window.scope, scope));
  return visible.map((window) => (
    <DocumentDeleteUndoRow
      key={window.operationId}
      window={window}
      className={className}
      style={style}
      onUndo={() => undo(window.operationId)}
      onDismiss={() => dismiss(window.operationId)}
    />
  ));
}

function DocumentDeleteUndoRow({
  window,
  className,
  style,
  onUndo,
  onDismiss,
}: {
  window: PresentedDeleteWindow;
  className?: string;
  style?: CSSProperties;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const restoring = window.feedback?.kind === "restoring";
  const row = (
    <div
      role="status"
      className={cn(
        "flex min-h-10 min-w-0 items-center gap-3 py-1.5 text-sm text-muted-foreground",
        className,
      )}
      style={style}
    >
      <span className="min-w-0 truncate">
        {restoring ? (
          <Trans>Restoring {window.label}</Trans>
        ) : (
          <Trans>Deleted {window.label}</Trans>
        )}
      </span>
      {!restoring && (window.feedback?.kind !== "failed" || window.feedback.retryable) ? (
        <button type="button" className="text-button shrink-0 text-sm" onClick={onUndo}>
          <Trans>Undo</Trans>
        </button>
      ) : null}
      <IconButton
        size="sm"
        className="ml-auto shrink-0 [@media(pointer:coarse)]:size-11"
        aria-label={t`Dismiss`}
        onClick={onDismiss}
      >
        <X aria-hidden className="size-4" />
      </IconButton>
    </div>
  );
  if (window.feedback?.kind !== "failed") return row;
  return (
    <>
      {row}
      <div className="px-2 text-destructive text-xs">{window.feedback.message}</div>
    </>
  );
}

/** The removals a landed delete recorded in its receipt; null while no successful delete receipt exists. */
async function readDeleteRemovals(projectId: string, operationId: string, signal: AbortSignal) {
  const receipt = await getContextOperationReceipt(projectId, operationId, { signal });
  if (!receipt?.result.ok) return null;
  const value = receipt.result.value;
  return "removed" in value ? value.removed : null;
}
