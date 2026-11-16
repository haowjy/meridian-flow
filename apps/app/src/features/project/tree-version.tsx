/**
 * The shell's version: the sidebar's one Live/Draft state, which its version chip shows. On Draft the shell shows the picked
 * Work's tree (live, then the Work's pending records, replayed in the browser), and every tree
 * action, click and Ctrl+Z in the sidebar acts there; on Live it is the live tree. The toggle is
 * offered while the Work has pending changes, and with none the shell is live. Every page shows
 * the version it says (`shownDraft` in `views.ts`): the Work's draft where it has one, else Live,
 * and a page live doesn't have stays on its draft. The page's version chip is the same state:
 * picking the Work's draft or Live there, or opening one of the Work's drafts anywhere
 * (`review-launch`, a review address), sets the toggle.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { type Work, type WorkLifecycleState, workLifecycleState } from "@meridian/contracts/works";
import { LIVE, pendingRecords } from "@meridian/project-tree";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { useTreeVersionChoice, writeTreeVersionChoice } from "@/client/project-shell/store";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { useTreeList } from "@/client/query/useProjectTree";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import {
  draftTreeVersion,
  LIVE_VERSION,
  type TreeVersion,
  TreeVersionContext,
} from "@/core/project-tree/tree-version";
import { workOwnerKey } from "@/features/draft-review/draft-owner-key";
import { type WorkTreeChanges, workTreeChanges } from "@/features/draft-review/tree-groups";
import { workDisplayName } from "@/lib/work-name";
import { useAccountId } from "./context/account-feature-context";
import { useScopeDraftOwner } from "./use-work-scope";

export type ShellTreeVersion = {
  version: TreeVersion;
  /** The Work's tree whichever way the toggle stands, for review; null with no branch. */
  draftVersion: TreeVersion | null;
  showing: "live" | "draft";
  /** The Work has pending changes: the toggle is offered. */
  offered: boolean;
  /** Whose drafts the toggle shows. */
  ownerKey: string;
  /** The Work's name, for the words on a page; null for a chat's own drafts. */
  name: string | null;
  /** The documents and folders the Work changes: marked in the tree on Live. Never a count. */
  changed: ReadonlySet<string>;
  /** What the Work's review count says: its changed documents and folders, the Changes list's items. */
  changeCount: number;
  /** The Work's tree changes, when its list is open; null with no branch. */
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
  return shell?.ownerKey === workOwnerKey(work)
    ? shell.changeCount
    : work.pendingDocumentCount + work.pendingFolderCount;
}

export function useWorkReviewCount(work: Work): number {
  return reviewCount(useShellTreeVersion(), work);
}

export function useDraftTreeVersion(
  branchId: string | null,
  rows: readonly ThreadDraftListItem[] | null,
  lifecycle: WorkLifecycleState = "active",
): TreeVersion | null {
  return useMemo(
    () => (branchId ? draftTreeVersion(branchId, rows, lifecycle) : null),
    [branchId, rows, lifecycle],
  );
}

export function TreeVersionProvider({
  projectId,
  chatThreadId,
  children,
}: {
  projectId: string;
  chatThreadId: string | null;
  children: ReactNode;
}) {
  const accountId = useAccountId();
  const { ownerKey, work } = useScopeDraftOwner(projectId, chatThreadId);
  const drafts = useOwnerDrafts(projectId, ownerKey);
  const { branchId, fileForDocument } = drafts;
  const project = useTreeList({ kind: "project", projectId });
  const account = useTreeList({ kind: "account", userId: accountId });
  const { drafts: rows } = drafts;
  const draftVersion = useDraftTreeVersion(
    branchId,
    rows,
    work ? workLifecycleState(work) : "active",
  );
  // The Work's tree changes, from the browser's replay of its view in each list its branch
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
                work: session.replay(draftVersion.view, draftVersion.pendingText),
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
  const offered = branchId !== null && changeCount > 0;
  const choice = useTreeVersionChoice(accountId, projectId);
  const showing = offered && choice === "draft" ? "draft" : "live";
  const version = showing === "draft" && draftVersion ? draftVersion : LIVE_VERSION;

  // Every page follows the choice (`shownDraft`): writing it is the whole flip.
  const show = useCallback(
    (next: "live" | "draft") => writeTreeVersionChoice(accountId, projectId, next),
    [accountId, projectId],
  );

  const name = work && !work.isNoWork ? workDisplayName(work) : null;
  const state = useMemo<ShellTreeVersion>(
    () => ({
      version,
      draftVersion,
      showing,
      offered,
      ownerKey,
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
      ownerKey,
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
