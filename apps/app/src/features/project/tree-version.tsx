/**
 * The shell's version: the sidebar's one Live/Draft toggle. On Draft the shell shows the picked
 * Work's tree (live, then the Work's pending records, replayed in the browser), and every tree
 * action, click and Ctrl+Z in the sidebar acts there; on Live it is the live tree. The toggle is
 * offered while the Work has pending changes, and with none the shell is live. Flipping it moves
 * main's page to the Work's draft of it, or back to Live. The page's version chip is the same
 * state: picking the Work's draft or Live there, or opening one of the Work's drafts anywhere
 * (`review-launch`), sets the toggle with it.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { pendingRecords } from "@meridian/project-tree";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { setDocumentView } from "@/client/project-shell/document-views";
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
import { useIsDraftOnly } from "./context/use-is-draft-only";
import { useScopeDraftOwner } from "./use-work-scope";
import { useOptionalMainItem } from "./views";

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
  /** Sets the toggle alone: the page already shows the version it names. */
  show: (next: "live" | "draft") => void;
  /** The toggle to Draft, with this page on the Work's draft of it. */
  showDraft: (documentId: string) => void;
};

const ShellTreeVersionContext = createContext<ShellTreeVersion | null>(null);

export function useShellTreeVersion(): ShellTreeVersion | null {
  return useContext(ShellTreeVersionContext);
}

/** A Work's tree: live, then the branch's pending records, keeping what it holds text on. */
export function useDraftTreeVersion(
  branchId: string | null,
  rows: readonly ThreadDraftListItem[] | null,
): TreeVersion | null {
  const pendingText = useMemo(
    () => new Set(rows?.filter((row) => row.hasDraft).map((row) => row.documentId)),
    [rows],
  );
  return useMemo<TreeVersion | null>(
    () => (branchId ? { view: { draft: branchId }, pendingText } : null),
    [branchId, pendingText],
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
  const draftVersion = useDraftTreeVersion(branchId, drafts.drafts);
  const version = showing === "draft" && draftVersion ? draftVersion : LIVE_VERSION;

  const main = useOptionalMainItem()?.item;
  const mainDocument = main?.kind === "document" ? main.documentId : null;
  const isDraftOnly = useIsDraftOnly(projectId);
  const show = useCallback(
    (next: "live" | "draft") => writeTreeVersionChoice(accountId, projectId, next),
    [accountId, projectId],
  );
  const showDraft = useCallback(
    (documentId: string) => {
      show("draft");
      const draft = fileForDocument(documentId);
      if (draft)
        setDocumentView(accountId, projectId, documentId, {
          pin: { ownerKey, itemKey: draft.draft.itemKey },
        });
    },
    [show, fileForDocument, accountId, projectId, ownerKey],
  );
  const flip = useCallback(() => {
    if (showing === "live") {
      if (mainDocument) showDraft(mainDocument);
      else show("draft");
      return;
    }
    show("live");
    // A page live has no version of keeps its draft on Live, as a Work pick leaves it.
    if (mainDocument && !isDraftOnly(mainDocument))
      setDocumentView(accountId, projectId, mainDocument, { version: "live" });
  }, [showing, show, showDraft, accountId, projectId, mainDocument, isDraftOnly]);

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
      showDraft,
    }),
    [
      version,
      draftVersion,
      showing,
      offered,
      ownerKey,
      name,
      changed,
      fileForDocument,
      flip,
      show,
      showDraft,
    ],
  );
  return (
    <ShellTreeVersionContext.Provider value={state}>
      <TreeVersionContext.Provider value={version}>{children}</TreeVersionContext.Provider>
    </ShellTreeVersionContext.Provider>
  );
}
