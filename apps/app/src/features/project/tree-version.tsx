/**
 * The shell's version: the sidebar's one Live/Draft state, which its version chip shows. On Draft the shell shows the picked
 * Work's tree (live, then the Work's pending records, replayed in the browser), and every tree
 * action, click and Ctrl+Z in the sidebar acts there; on Live it is the live tree. The toggle is
 * offered while the Work has pending changes, and with none the shell is live. Every page shows
 * the version it says (`shownDraft` in `views.ts`): the Work's draft where it has one, else Live,
 * and a page live doesn't have stays on its draft. The page's version chip is the same state:
 * picking the Work's draft or Live there, or opening one of the Work's drafts anywhere
 * (`review-launch`, a review address), sets the toggle; a change of the scope's draft owner puts
 * it on Draft.
 */
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
} from "react";
import { enterScope } from "@/client/project-shell/document-views";
import { useTreeVersionChoice, writeTreeVersionChoice } from "@/client/project-shell/store";
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
import { useAccountId } from "./context/account-feature-context";
import { useScopeDraftOwner } from "./use-work-scope";

export type ShellTreeVersion = {
  version: TreeVersion;
  /** The Work's tree whichever way the toggle stands, for review; null with no draft. */
  draftVersion: TreeVersion | null;
  showing: "live" | "draft";
  /** The Work has pending changes: the toggle is offered. */
  offered: boolean;
  /** Whose drafts the toggle shows. */
  draftId: string;
  /** The Work whose drafts these are, for `WorkName`; null for a chat's own drafts. */
  work: Work | null;
  /** The Work's name (`nameOf`), for the words on a page; null for a chat's own drafts. */
  name: string | null;
  /** The documents and folders the Work changes: marked in the tree on Live. Never a count. */
  changed: ReadonlySet<string>;
  /** What the Work's review count says: its changed documents and folders, the Changes list's items. */
  changeCount: number;
  /** The Work's tree changes, when its list is open; null with no draft. */
  tree: WorkTreeChanges | null;
  /** The Work's draft of a document, which a click on Draft opens. */
  draftOf: (documentId: string) => ReviewFileTarget | null;
  /** Sets the toggle: every page that has the Work's draft shows it, or Live. */
  show: (next: "live" | "draft") => void;
};

const ShellTreeVersionContext = createContext<ShellTreeVersion | null>(null);

export function useShellTreeVersion(): ShellTreeVersion | null {
  return useContext(ShellTreeVersionContext);
}

/**
 * A Work's review count, the one every surface shows: the Changes list's items when the shell has
 * the Work's list open (a change made offline or in flight is in it already), else the stored
 * count the Works list carries, which the open list agrees with once it syncs.
 */
export function reviewCount(shell: ShellTreeVersion | null, work: Work): number {
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

/** The owner key of a new chat on screen: a scope whose drafts nobody holds yet. */
const NO_OWNER = "new-chat";

export function TreeVersionProvider({
  projectId,
  chatThreadId,
  newChat,
  children,
}: {
  projectId: string;
  chatThreadId: string | null;
  /** A new chat's composer is on screen: under None, a scope with no drafts. */
  newChat: boolean;
  children: ReactNode;
}) {
  const accountId = useAccountId();
  const { draftId, work } = useScopeDraftOwner(projectId, chatThreadId);
  // Whose drafts the scope shows changed hands: pages leave the drafts of the owner before and
  // show the new owner's (`enterScope`). A new chat on screen has no drafts, so it is a change to
  // no owner. "" with no new chat is no owner known yet (no chat on screen, or its row still
  // loading), which changes nothing. A layout effect, so the address's arrival after it in this
  // commit wins. A Work pick has already run `enterScope` with the scope's write, and this run
  // finds nothing to change.
  const queryClient = useQueryClient();
  const ownerKey = draftId || (newChat ? NO_OWNER : "");
  const owner = useRef(ownerKey);
  useLayoutEffect(() => {
    if (!ownerKey) return;
    if (owner.current && owner.current !== ownerKey)
      enterScope(queryClient, accountId, projectId, ownerKey === NO_OWNER ? null : ownerKey);
    owner.current = ownerKey;
  }, [queryClient, accountId, projectId, ownerKey]);
  const drafts = useOwnerDrafts(projectId, draftId);
  const { draftId: listedDraft, fileForDocument } = drafts;
  const project = useTreeList({ kind: "project", projectId });
  const account = useTreeList({ kind: "account", userId: accountId });
  const { data: rows } = drafts;
  const draftVersion = useDraftTreeVersion(listedDraft, work ? workLifecycleState(work) : "active");
  // The Work's tree changes, from the browser's replay of its view in each list its draft
  // spans: what the Changes list builds its folder groups from, including a change not yet
  // admitted (made offline or in flight).
  const tree = useMemo(() => {
    const draft = draftVersion?.view.draft ?? null;
    if (!draftVersion || draft === null) return null;
    return workTreeChanges(
      [project, account].flatMap(({ session, snapshot }) =>
        session && snapshot
          ? [
              {
                live: session.replay(LIVE),
                work: session.replay(draftVersion.view),
                pending: pendingRecords(snapshot.doc, draft),
              },
            ]
          : [],
      ),
    );
  }, [draftVersion, project, account]);
  // Documents from the server's pending drafts, folders from the replay.
  const changeCount = (rows?.length ?? 0) + (tree?.folders.size ?? 0);
  // The nodes the tree marks on Live.
  const changed = useMemo(
    () => new Set([...(rows ?? []).map((row) => row.documentId), ...(tree?.folders ?? [])]),
    [rows, tree],
  );
  const offered = listedDraft !== null && changeCount > 0;
  const choice = useTreeVersionChoice(accountId, projectId);
  const showing = offered && choice === "draft" ? "draft" : "live";
  const version = showing === "draft" && draftVersion ? draftVersion : LIVE_VERSION;

  // Every page follows the choice (`shownDraft`): writing it is the whole flip.
  const show = useCallback(
    (next: "live" | "draft") => writeTreeVersionChoice(accountId, projectId, next),
    [accountId, projectId],
  );

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
      work: named,
      name,
      changed,
      changeCount,
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
      named,
      name,
      changed,
      changeCount,
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
