import type { DraftOwnerKey } from "@meridian/contracts/branches";
import type { Work } from "@meridian/contracts/works";
import { useCallback, useMemo } from "react";
import { pickWorkViews } from "@/client/project-shell/document-views";
import {
  NO_SCOPE,
  useProjectScope,
  writeProjectScope,
  writeTreeVersionChoice,
} from "@/client/project-shell/store";
import { useDisplayedThread } from "@/client/query/useDisplayedThread";
import { useWorks, workFromSnapshot } from "@/client/query/useWorks";
import { chatOwnerKey, workOwnerKey } from "@/features/draft-review/draft-owner-key";
import { useAccountId, useOptionalDraftOnlyPresentations } from "./context/account-feature-context";

/** The Work scope as the shell can use it: ready with a Work row id (No Work's included), or not yet. */
export type WorkScope =
  | { status: "ready"; workId: string }
  | { status: "loading" | "error"; workId: null };

/**
 * The one Work scope per project: whose drafts, chats and Scratch the shell shows. It is a stored
 * value, never read from the address, and only the writer's pick changes it. An archived or
 * deleted Work stays picked (it is ended, restorable, and its sources still read); only a Work the
 * catalog no longer holds (purged) resolves to No Work, and nothing navigates.
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
    (works.works?.some((work) => work.id === stored) ||
      works.deleted.some((work) => work.id === stored) ||
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
 * Pick a Work, or No Work by its row id. Main, the address and the open documents stay put; a page
 * on the picked Work's draft stays on it with the toggle on Draft, and every other page showing a
 * draft returns to Live with the toggle (`pickWorkViews`). Written with the scope, so the first
 * render under the new scope already shows them.
 */
export function useWorkScope(projectId: string): {
  workId: string | null;
  setWorkId(id: string): void;
} {
  const accountId = useAccountId();
  const works = useWorks(projectId);
  const noWorkId = works.noWork?.id ?? null;
  const { workId } = useWorkScopeState(projectId);
  const draftOnly = useOptionalDraftOnlyPresentations();
  const setWorkId = useCallback(
    (id: string) => {
      if (id === workId) return;
      const onWorkDraft = pickWorkViews(
        accountId,
        projectId,
        id === noWorkId ? null : workOwnerKey({ id }),
        (documentId) => draftOnly?.isDraftOnly(projectId, documentId) ?? false,
      );
      writeTreeVersionChoice(accountId, projectId, onWorkDraft ? "draft" : "live");
      writeProjectScope(accountId, projectId, id === noWorkId ? NO_SCOPE : id);
    },
    [accountId, projectId, noWorkId, workId, draftOnly],
  );
  return useMemo(() => ({ workId, setWorkId }), [workId, setWorkId]);
}

/**
 * Whose drafts the scope holds: the picked Work's, or under No Work the chat on screen's, which
 * are its Work's when it has one and its own when it has none. The sidebar's toggle, Changes
 * and the Work chip all show these, so under No Work they follow the chat. `ownerKey` is "" when
 * there are none to show; `work` is the Work its commands act for.
 */
export function useScopeDraftOwner(
  projectId: string,
  chatThreadId: string | null,
): { picked: Work | null; work: Work | null; ownerKey: DraftOwnerKey | "" } {
  const { workId } = useWorkScope(projectId);
  const { works, deleted, noWork } = useWorks(projectId);
  const thread = useDisplayedThread(projectId, chatThreadId);
  const snapshot = noWork ? { works: works ?? [], noWork } : null;
  // A deleted Work stays the pick until it is purged, as the scope keeps it.
  const picked =
    workId && workId !== noWork?.id
      ? (workFromSnapshot(snapshot, workId) ?? deleted.find((work) => work.id === workId) ?? null)
      : null;
  const chatWork = thread?.workId ? workFromSnapshot(snapshot, thread.workId) : null;
  const chatKey = picked ? "" : chatOwnerKey(chatWork, thread?.rootThreadId ?? null);
  return useMemo(
    () =>
      picked
        ? { picked, work: picked, ownerKey: workOwnerKey(picked) }
        : { picked: null, work: chatKey ? chatWork : null, ownerKey: chatKey },
    [picked, chatWork, chatKey],
  );
}
