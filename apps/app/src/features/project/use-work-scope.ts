import type { Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useAccountId } from "@/client/account/account-context";
import { enterScope } from "@/client/project-shell/document-views";
import {
  NO_SCOPE,
  useProjectScope,
  useShownWorkDraft,
  writeProjectScope,
} from "@/client/project-shell/store";
import { useWorkDrafts, type WorkDraftsState } from "@/client/query/draft-commands";
import { useDisplayedThread } from "@/client/query/useDisplayedThread";
import { useWorks, workFromSnapshot } from "@/client/query/useWorks";

export type WorkScope =
  | { status: "ready"; workId: string }
  | { status: "loading" | "error"; workId: null };

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

export function useWorkScope(projectId: string): {
  workId: string | null;
  setWorkId(id: string): void;
} {
  const accountId = useAccountId();
  const queryClient = useQueryClient();
  const works = useWorks(projectId);
  const noWorkId = works.noWork?.id ?? null;
  const { workId } = useWorkScopeState(projectId);
  const setWorkId = useCallback(
    (id: string) => {
      if (id === workId) return;
      const draft = id === noWorkId ? null : workDraftId(works, id);
      enterScope(queryClient, accountId, projectId, draft);
      writeProjectScope(accountId, projectId, id === noWorkId ? NO_SCOPE : id);
    },
    [queryClient, accountId, projectId, noWorkId, workId, works],
  );
  return useMemo(() => ({ workId, setWorkId }), [workId, setWorkId]);
}

export function useScopeDraftOwner(
  projectId: string,
  chatThreadId: string | null,
): {
  picked: Work | null;
  work: Work | null;
  draftId: string;
  known: boolean;
  workDrafts: WorkDraftsState;
} {
  const accountId = useAccountId();
  const { workId } = useWorkScope(projectId);
  const catalog = useWorks(projectId);
  const { works, deleted, noWork } = catalog;
  const thread = useDisplayedThread(projectId, chatThreadId);
  const snapshot = noWork ? { works: works ?? [], noWork } : null;
  const picked =
    workId && workId !== noWork?.id
      ? (workFromSnapshot(snapshot, workId) ?? deleted.find((work) => work.id === workId) ?? null)
      : null;
  const shown = useShownWorkDraft(accountId, projectId);
  const workDrafts = useWorkDrafts(projectId, picked?.id ?? null);
  const { drafts } = workDrafts;
  const pickedDraft =
    picked &&
    shown?.workId === picked.id &&
    (drafts === null || drafts.some((draft) => draft.id === shown.draftId))
      ? shown.draftId
      : (drafts?.find((draft) => draft.isDefault)?.id ?? picked?.draftId ?? "");
  const creating = !picked && workId ? catalog.creations.get(workId)?.work.draftId : undefined;
  const chatWork = thread?.workId ? workFromSnapshot(snapshot, thread.workId) : null;
  const chatKey = picked || creating || !chatWork || !thread ? "" : thread.draftId;
  const known = workId !== null;
  return useMemo(
    () =>
      picked
        ? { picked, work: picked, draftId: pickedDraft, known, workDrafts }
        : creating
          ? { picked: null, work: null, draftId: creating, known, workDrafts }
          : { picked: null, work: chatKey ? chatWork : null, draftId: chatKey, known, workDrafts },
    [picked, pickedDraft, creating, chatWork, chatKey, known, workDrafts],
  );
}

function workDraftId(works: ReturnType<typeof useWorks>, id: string): string | null {
  return (
    works.works?.find((work) => work.id === id)?.draftId ??
    works.creations.get(id)?.work.draftId ??
    null
  );
}
