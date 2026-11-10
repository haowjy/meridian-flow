import { isWorkArchived } from "@meridian/contracts/works";
import { useCallback, useMemo } from "react";
import { NO_SCOPE, useProjectScope, writeProjectScope } from "@/client/project-shell/store";
import { useWorks } from "@/client/query/useWorks";
import { useAccountId } from "./context/account-feature-context";

/** The Work scope as the shell can use it: ready with a Work row id (No Work's included), or not yet. */
export type WorkScope =
  | { status: "ready"; workId: string }
  | { status: "loading" | "error"; workId: null };

/**
 * The one Work scope per project: whose drafts, chats and Scratch the shell shows. It is a stored
 * value, never read from the address, and only the Work picker writes it. A stored Work the
 * catalog no longer holds, or that is archived (it refuses new chats and freezes its drafts), resolves
 * to No Work, and nothing navigates.
 */
export function useWorkScopeState(projectId: string): WorkScope & { retry: () => void } {
  const accountId = useAccountId();
  const stored = useProjectScope(accountId, projectId);
  const works = useWorks(projectId);
  const noWorkId = works.noWork?.id ?? null;
  const { refetch } = works;
  const ready = works.status === "ready" || works.status === "empty";
  const known =
    stored !== NO_SCOPE &&
    (works.works?.some((work) => work.id === stored && !isWorkArchived(work)) ||
      works.creations.has(stored));
  return useMemo(() => {
    const scope: WorkScope =
      ready && noWorkId
        ? { status: "ready", workId: known ? stored : noWorkId }
        : { status: works.status === "error" ? "error" : "loading", workId: null };
    return { ...scope, retry: refetch };
  }, [ready, noWorkId, known, stored, works.status, refetch]);
}

/**
 * Pick a Work, or No Work by its row id. Only the scope changes: main, the address and the open
 * documents stay put. The project view then drops every pinned draft, so each document re-resolves
 * under the new scope.
 */
export function useWorkScope(projectId: string): {
  workId: string | null;
  setWorkId(id: string): void;
} {
  const accountId = useAccountId();
  const works = useWorks(projectId);
  const noWorkId = works.noWork?.id ?? null;
  const { workId } = useWorkScopeState(projectId);
  const setWorkId = useCallback(
    (id: string) => {
      writeProjectScope(accountId, projectId, id === noWorkId ? NO_SCOPE : id);
    },
    [accountId, projectId, noWorkId],
  );
  return useMemo(() => ({ workId, setWorkId }), [workId, setWorkId]);
}
