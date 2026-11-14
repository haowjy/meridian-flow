/**
 * The shell's version: the sidebar's one Live/Draft toggle. On Draft the shell shows the picked
 * Work's tree (live, then the Work's pending records, replayed in the browser), and every tree
 * action, click and Ctrl+Z in the sidebar acts there; on Live it is the live tree. The toggle is
 * offered while the Work has pending changes, and with none the shell is live. Every page shows
 * the version it says (`shownDraft` in `views.ts`): the Work's draft where it has one, else Live,
 * and a page live doesn't have stays on its draft. The page's version chip is the same state:
 * picking the Work's draft or Live there, or opening one of the Work's drafts anywhere
 * (`review-launch`, a review address), sets the toggle.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { type WorkLifecycleState, workLifecycleState } from "@meridian/contracts/works";
import { pendingRecords } from "@meridian/project-tree";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { useTreeVersionChoice, writeTreeVersionChoice } from "@/client/project-shell/store";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { useTreeList } from "@/client/query/useProjectTree";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import {
  LIVE_VERSION,
  type TreeVersion,
  TreeVersionContext,
} from "@/core/project-tree/tree-version";
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
  /** The documents and folders the Work changes: marked in the tree on Live. */
  changed: ReadonlySet<string>;
  /** The Work's draft of a document, which a click on Draft opens. */
  draftOf: (documentId: string) => ReviewFileTarget | null;
  flip: () => void;
  /** Sets the toggle: every page that has the Work's draft shows it, or Live. */
  show: (next: "live" | "draft") => void;
};

const ShellTreeVersionContext = createContext<ShellTreeVersion | null>(null);

export function useShellTreeVersion(): ShellTreeVersion | null {
  return useContext(ShellTreeVersionContext);
}

/**
 * A Work's tree: live, then the branch's pending records, keeping what it holds text on. One
 * value per branch while what it holds is unchanged, whoever reads it (the shell, a review's
 * route, an Apply's Undo step): the list replays a view once per change only for one set.
 */
export function draftTreeVersion(
  branchId: string,
  rows: readonly ThreadDraftListItem[] | null,
  lifecycle: WorkLifecycleState = "active",
): TreeVersion {
  const pendingText = new Set(rows?.flatMap((row) => (row.hasDraft ? [row.documentId] : [])));
  const ended = lifecycle !== "active" ? lifecycle : undefined;
  const held = draftVersions.get(branchId);
  if (held && held.ended === ended && sameSet(held.pendingText, pendingText)) return held;
  const version: TreeVersion = {
    view: { draft: branchId },
    pendingText,
    ...(ended ? { ended } : {}),
  };
  draftVersions.set(branchId, version);
  return version;
}
const draftVersions = new Map<string, TreeVersion>();

function sameSet(a: ReadonlySet<string> | undefined, b: ReadonlySet<string>): boolean {
  if (a?.size !== b.size) return false;
  for (const id of b) if (!a.has(id)) return false;
  return true;
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
  const projectVersion = project.snapshot?.version;
  const accountVersion = account.snapshot?.version;
  // A change to a folder alone lists no document, so the list says what else the Work changes.
  const rows = drafts.drafts;
  const changed = useMemo(() => {
    const nodes = new Set(rows?.map((row) => row.documentId));
    if (branchId === null) return nodes;
    for (const snapshot of [project.snapshot, account.snapshot])
      if (snapshot)
        for (const record of pendingRecords(snapshot.doc, branchId)) nodes.add(record.node);
    return nodes;
    // `version` is what changes when the copy does.
  }, [branchId, rows, project.snapshot, account.snapshot, projectVersion, accountVersion]);
  const offered = branchId !== null && changed.size > 0;
  const choice = useTreeVersionChoice(accountId, projectId);
  const showing = offered && choice === "draft" ? "draft" : "live";
  const draftVersion = useDraftTreeVersion(
    branchId,
    drafts.drafts,
    work ? workLifecycleState(work) : "active",
  );
  const version = showing === "draft" && draftVersion ? draftVersion : LIVE_VERSION;

  // Every page follows the choice (`shownDraft`): writing it is the whole flip.
  const show = useCallback(
    (next: "live" | "draft") => writeTreeVersionChoice(accountId, projectId, next),
    [accountId, projectId],
  );
  const flip = useCallback(() => show(showing === "live" ? "draft" : "live"), [show, showing]);

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
      draftOf: fileForDocument,
      flip,
      show,
    }),
    [version, draftVersion, showing, offered, ownerKey, name, changed, fileForDocument, flip, show],
  );
  return (
    <ShellTreeVersionContext.Provider value={state}>
      <TreeVersionContext.Provider value={version}>{children}</TreeVersionContext.Provider>
    </ShellTreeVersionContext.Provider>
  );
}
