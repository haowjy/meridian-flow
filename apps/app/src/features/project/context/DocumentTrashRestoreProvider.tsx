/** One project-lifetime owner for Trash restore progress and outcomes. */
import { t } from "@lingui/core/macro";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { documentLocationName } from "../../chat/document-display-name";
import { useReportRestoredRemovals } from "./document-delete-undo";
import { restoreTrashedDocument, type TrashRestoreOutcome } from "./restore-trashed-document";

export type TrashRestoreState = { kind: "restoring" } | { kind: "failed"; message: string };

type AfterRestore = (
  outcome: Extract<TrashRestoreOutcome, { kind: "living" }>,
) => Promise<string | null>;

type RestoreContextValue = {
  states: ReadonlyMap<string, TrashRestoreState>;
  restore: (entry: DocumentTrashEntry, afterRestore?: AfterRestore) => void;
};

type RestoredNotice = { id: number; location: string };

const RestoreContext = createContext<RestoreContextValue | null>(null);

export function DocumentTrashRestoreProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const reportRestored = useReportRestoredRemovals();
  const [notice, setNotice] = useState<RestoredNotice | null>(null);
  const [states, setStates] = useState<ReadonlyMap<string, TrashRestoreState>>(() => new Map());
  const restore = useCallback(
    (entry: DocumentTrashEntry, afterRestore?: AfterRestore) => {
      if (states.get(entry.documentId)?.kind === "restoring") return;
      setStates((current) => new Map(current).set(entry.documentId, { kind: "restoring" }));
      void restoreTrashedDocument(queryClient, projectId, entry)
        .then(async (outcome) => {
          if (outcome.kind === "living") {
            reportRestored([entry]);
            const failure = afterRestore ? await afterRestore(outcome) : null;
            if (failure) {
              setStates((current) =>
                new Map(current).set(entry.documentId, { kind: "failed", message: failure }),
              );
            } else {
              setStates((current) => {
                const next = new Map(current);
                next.delete(entry.documentId);
                return next;
              });
            }
            if (outcome.landedAt) {
              setNotice({ id: Date.now(), location: documentLocationName(outcome.landedAt) });
            }
            return;
          }
          if (outcome.kind === "superseded") {
            setStates((current) => {
              const next = new Map(current);
              next.delete(entry.documentId);
              return next;
            });
            return;
          }
          setStates((current) =>
            new Map(current).set(entry.documentId, {
              kind: "failed",
              message: restoreFailureMessage(entry.name, outcome.kind),
            }),
          );
        })
        .catch(() =>
          setStates((current) =>
            new Map(current).set(entry.documentId, {
              kind: "failed",
              message: restoreFailureMessage(entry.name, "network"),
            }),
          ),
        );
    },
    [projectId, queryClient, reportRestored, states],
  );
  const value = useMemo(() => ({ states, restore }), [states, restore]);
  return (
    <RestoreContext.Provider value={value}>
      {children}
      <RestoredAtNotice notice={notice} onDismiss={() => setNotice(null)} />
    </RestoreContext.Provider>
  );
}

export function useDocumentTrashRestore(): RestoreContextValue {
  const value = useContext(RestoreContext);
  if (!value) throw new Error("Document Trash restore requires its project provider");
  return value;
}

function RestoredAtNotice({
  notice,
  onDismiss,
}: {
  notice: RestoredNotice | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(onDismiss, 4_000);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);
  if (!notice) return null;
  return (
    <div
      key={notice.id}
      role="status"
      className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-md bg-foreground px-3 py-1.5 text-background text-caption shadow-card"
    >
      {t`Restored at ${notice.location}.`}
    </div>
  );
}

function restoreFailureMessage(
  name: string,
  outcome: "superseded" | "ancestor_taken" | "refused" | "network",
): string {
  if (outcome === "ancestor_taken") return t`Couldn't restore ${name}. A file is in the way.`;
  if (outcome === "network") return t`Couldn't restore ${name}. Try again.`;
  return t`Couldn't restore ${name}.`;
}
