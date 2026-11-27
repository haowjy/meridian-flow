import { type Work, type WorkLifecycleState, workLifecycleState } from "@meridian/contracts/works";
import { LIVE, pendingRecords } from "@meridian/project-tree";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { enterScope } from "@/client/project-shell/document-views";
import {
  useTreeVersionChoice,
  writeShownWorkDraft,
  writeTreeVersionChoice,
} from "@/client/project-shell/store";
import type { WorkDraftsState } from "@/client/query/draft-commands";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { useTreeList } from "@/client/query/useProjectTree";
import { useWorks } from "@/client/query/useWorks";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import {
  draftTreeVersion,
  LIVE_VERSION,
  type TreeVersion,
  TreeVersionContext,
} from "@/core/project-tree/tree-version";
import { type WorkTreeChanges, workTreeChanges } from "@/features/draft-review/tree-groups";
import { useAccountId, useDraftCommandOwner } from "./context/account-feature-context";
import { useScopeDraftOwner } from "./use-work-scope";

export type ShellTreeVersion = {
  version: TreeVersion;
  draftVersion: TreeVersion | null;
  showing: "live" | "draft";
  offered: boolean;
  draftId: string;
  workDrafts: WorkDraftsState | null;
  pick: (draftId: string) => void;
  leave: () => void;
  work: Work | null;
  name: string | null;
  changed: ReadonlySet<string>;
  changeCount: number;
  pressedDrafts: ReadonlySet<string>;
  tree: WorkTreeChanges | null;
  draftOf: (documentId: string) => ReviewFileTarget | null;
  show: (next: "live" | "draft") => void;
};

const ShellTreeVersionContext = createContext<ShellTreeVersion | null>(null);

export function useShellTreeVersion(): ShellTreeVersion | null {
  return useContext(ShellTreeVersionContext);
}

export function reviewCount(shell: ShellTreeVersion | null, work: Work): number {
  const drafts = shell?.work?.id === work.id ? shell.workDrafts?.drafts : null;
  if (shell && drafts)
    return drafts.reduce(
      (sum, draft) =>
        sum +
        (draft.id === shell.draftId
          ? shell.changeCount
          : shell.pressedDrafts.has(draft.id)
            ? 0
            : draft.pendingDocumentCount + draft.pendingFolderCount),
      0,
    );
  return shell && shell.draftId === work.draftId
    ? shell.changeCount
    : work.pendingDocumentCount + work.pendingFolderCount;
}

export function useWorkReviewCount(work: Work): number {
  return reviewCount(useShellTreeVersion(), work);
}

export function useDraftTreeVersion(
  draftId: string | null,
  lifecycle: WorkLifecycleState = "active",
): TreeVersion | null {
  return draftId ? draftTreeVersion(draftId, lifecycle) : null;
}

const NO_OWNER = "new-chat";

export function useDraftsTreeChanges(
  projectId: string,
  versions: readonly TreeVersion[],
): ReadonlyMap<string, WorkTreeChanges> {
  const accountId = useAccountId();
  const project = useTreeList({ kind: "project", projectId });
  const account = useTreeList({ kind: "account", userId: accountId });
  return useMemo(() => {
    const changes = new Map<string, WorkTreeChanges>();
    for (const version of versions) {
      const draft = version.view.draft;
      if (draft === null) continue;
      changes.set(
        draft,
        workTreeChanges(
          [project, account].flatMap(({ session, snapshot }) =>
            session && snapshot
              ? [
                  {
                    live: session.replay(LIVE),
                    work: session.replay(version.view),
                    pending: pendingRecords(snapshot.doc, draft),
                  },
                ]
              : [],
          ),
        ),
      );
    }
    return changes;
  }, [versions, project, account]);
}

export function TreeVersionProvider({
  projectId,
  chatThreadId,
  newChat,
  children,
}: {
  projectId: string;
  chatThreadId: string | null;
  newChat: boolean;
  children: ReactNode;
}) {
  const accountId = useAccountId();
  const { draftId, work, picked, known, workDrafts } = useScopeDraftOwner(projectId, chatThreadId);
  // Whose drafts the scope shows changed hands: pages leave the drafts of the owner before and
  // show the new owner's (`enterScope`). A new chat on screen has no drafts, so it is a change to
  // no owner. "" with no new chat, or any owner before the Works list loads, is no owner known
  // yet (no chat on screen, or its row or the Works list still loading), which changes nothing. A layout effect, so the address's arrival after it in this
  // commit wins. A Work pick has already run `enterScope` with the scope's write, and this run
  // finds nothing to change.
  const queryClient = useQueryClient();
  const ownerKey = known ? draftId || (newChat ? NO_OWNER : "") : "";
  // A move between one picked Work's drafts leaves the toggle as the move set it: a pick puts it
  // on Draft, `Delete draft` on Live.
  const pickedId = picked?.id ?? null;
  const owner = useRef({ key: ownerKey, work: pickedId });
  useLayoutEffect(() => {
    if (!ownerKey) return;
    const before = owner.current;
    if (before.key && before.key !== ownerKey)
      enterScope(
        queryClient,
        accountId,
        projectId,
        ownerKey === NO_OWNER ? null : ownerKey,
        pickedId !== null && before.work === pickedId,
      );
    owner.current = { key: ownerKey, work: pickedId };
  }, [queryClient, accountId, projectId, ownerKey, pickedId]);
  const drafts = useOwnerDrafts(projectId, draftId);
  const { draftId: listedDraft, fileForDocument } = drafts;
  const { data: rows } = drafts;
  const draftVersion = useDraftTreeVersion(listedDraft, work ? workLifecycleState(work) : "active");
  const versions = useMemo(() => (draftVersion ? [draftVersion] : []), [draftVersion]);
  const tree = useDraftsTreeChanges(projectId, versions).get(listedDraft ?? "") ?? null;
  // Documents and folders come from the draft-list read, which has already subtracted every
  // journal hold, so all surfaces count the same rows.
  const commands = useDraftCommandOwner();
  const count = () => (rows?.length ?? 0) + (drafts.folderIds?.length ?? 0);
  const changeCount = useSyncExternalStore(commands.subscribe, count, count);
  const pressed = () =>
    (workDrafts.drafts ?? [])
      .flatMap((draft) => (commands.holdsDraft(draft.id) ? [draft.id] : []))
      .join(",");
  const pressedKey = useSyncExternalStore(commands.subscribe, pressed, pressed);
  const pressedDrafts = useMemo(
    () => new Set(pressedKey ? pressedKey.split(",") : []),
    [pressedKey],
  );
  const changed = useMemo(
    () => new Set([...(rows ?? []).map((row) => row.documentId), ...(tree?.folders ?? [])]),
    [rows, tree],
  );
  const offered = listedDraft !== null && (changeCount > 0 || workDrafts.drafts !== null);
  const choice = useTreeVersionChoice(accountId, projectId);
  const showing = offered && choice === "draft" ? "draft" : "live";
  const version = showing === "draft" && draftVersion ? draftVersion : LIVE_VERSION;

  const show = useCallback(
    (next: "live" | "draft") => writeTreeVersionChoice(accountId, projectId, next),
    [accountId, projectId],
  );
  const pick = useCallback(
    (next: string) => {
      if (!pickedId) return;
      writeShownWorkDraft(accountId, projectId, { workId: pickedId, draftId: next });
      writeTreeVersionChoice(accountId, projectId, "draft");
    },
    [accountId, projectId, pickedId],
  );
  const leave = useCallback(() => {
    writeShownWorkDraft(accountId, projectId, null);
    writeTreeVersionChoice(accountId, projectId, "live");
  }, [accountId, projectId]);

  const { nameOf } = useWorks(projectId);
  const named = work && !work.isNoWork ? work : null;
  const name = named ? nameOf(named) : null;
  const state = useMemo<ShellTreeVersion>(
    () => ({
      version,
      draftVersion,
      showing,
      offered,
      draftId,
      workDrafts: workDrafts.drafts ? workDrafts : null,
      pick,
      leave,
      work: named,
      name,
      changed,
      changeCount,
      pressedDrafts,
      tree,
      draftOf: fileForDocument,
      show,
    }),
    [
      version,
      draftVersion,
      showing,
      offered,
      draftId,
      workDrafts,
      pick,
      leave,
      named,
      name,
      changed,
      changeCount,
      pressedDrafts,
      tree,
      fileForDocument,
      show,
    ],
  );
  return (
    <ShellTreeVersionContext.Provider value={state}>
      <TreeVersionContext.Provider value={version}>{children}</TreeVersionContext.Provider>
    </ShellTreeVersionContext.Provider>
  );
}
