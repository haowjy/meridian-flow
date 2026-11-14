/** Settles every draft-only document the project's hosts present, one owner's drafts at a time. */

import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useSyncExternalStore } from "react";
import {
  type DraftPin,
  setDocumentView,
  useDocumentViews,
} from "@/client/project-shell/document-views";
import { fetchCurrentDraftMetadata } from "@/client/query/useDraftMetadata";
import {
  cachedOwnerDrafts,
  ownerDraftsQueryOptions,
  useOwnerDrafts,
} from "@/client/query/useOwnerDrafts";
import { useProjectTrees } from "@/client/query/useProjectTrees";
import {
  useAccountId,
  useOptionalContextRemovalCoordinator,
  useOptionalDraftOnlyPresentations,
  useOptionalRemovedNotices,
  useProjectStandings,
} from "@/features/project/context/account-feature-context";
import { useOptionalChatOnScreen } from "@/features/project/side/SideView";
import { useScopeDraftOwner } from "@/features/project/use-work-scope";
import type { DraftOnlyPresentation, DraftOnlyPresentations } from "./draft-only-presentations";
import type { DraftRef } from "./review-command-types";

const NONE: readonly DraftOnlyPresentation[] = [];

export function DraftOnlySettlement({ projectId }: { projectId: string }) {
  const registry = useOptionalDraftOnlyPresentations();
  const presentations = useSyncExternalStore(
    registry?.subscribe ?? (() => () => undefined),
    () => registry?.presentations(projectId) ?? NONE,
    () => NONE,
  );
  const scopeOwnerKey = useScopeDraftOwner(projectId, useOptionalChatOnScreen()).ownerKey;
  if (!registry) return null;
  const owners = new Set(presentations.map((draft) => draft.ownerKey));
  return [...owners].map((ownerKey) => (
    <OwnerSettlement
      key={ownerKey}
      projectId={projectId}
      ownerKey={ownerKey}
      scopeOwnerKey={scopeOwnerKey}
      registry={registry}
      membership={JSON.stringify(presentations.filter((draft) => draft.ownerKey === ownerKey))}
    />
  ));
}

/**
 * The draft a document live lacks shows once its presented draft ended: the one its view picked
 * since, else the scope's, if its owner still lists it. Read fresh, so a draft that ended with the
 * presented one is not taken for a live one.
 */
async function successorDraft(
  queryClient: QueryClient,
  ended: DraftRef,
  pinned: DraftPin | undefined,
  scopeOwnerKey: string,
): Promise<DraftPin | null> {
  const listed = async (ownerKey: string) =>
    (
      await queryClient.fetchQuery({
        ...ownerDraftsQueryOptions(ended.projectId, ownerKey),
        staleTime: 0,
      })
    ).items.filter((item) => item.documentId === ended.documentId);
  if (pinned && pinned.itemKey !== ended.itemKey) {
    const rows = await listed(pinned.ownerKey);
    if (rows.some((row) => row.itemKey === pinned.itemKey)) return pinned;
  }
  if (!scopeOwnerKey || scopeOwnerKey === ended.ownerKey) return null;
  const row = (await listed(scopeOwnerKey))[0];
  return row ? { ownerKey: scopeOwnerKey, itemKey: row.itemKey } : null;
}

function OwnerSettlement({
  projectId,
  ownerKey,
  scopeOwnerKey,
  registry,
  membership,
}: {
  projectId: string;
  ownerKey: string;
  scopeOwnerKey: string;
  registry: DraftOnlyPresentations;
  membership: string;
}) {
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const standings = useProjectStandings();
  const removal = useOptionalContextRemovalCoordinator();
  const notices = useOptionalRemovedNotices();
  const drafts = useOwnerDrafts(projectId, ownerKey);
  const views = useDocumentViews(accountId, projectId);
  const trees = useProjectTrees(projectId);
  const presentations = () =>
    registry.presentations(projectId).filter((draft) => draft.ownerKey === ownerKey);
  // Which presentations the project's tree holds: what the effects below re-run on, not the
  // tree's every change.
  const held = JSON.stringify(
    presentations().map((draft) => trees.find(draft.documentId) !== null),
  );
  // The effects read the tree as it stands when they decide, after any wait.
  const latestTrees = useRef(trees);
  latestTrees.current = trees;
  // The pending list omits a draft with no effect (and one inside the `has_effect` lag), so
  // leaving it proves nothing. For an unlisted presentation the tree decides first: a document
  // it now shows was applied and its hosts go live. Otherwise only the draft's own metadata and
  // the document's view may end it. A document that another draft (the view's new pick, the
  // scope's, or one still held) also has paints that one; only one no draft has closes.
  useEffect(() => {
    if (!projectId || !ownerKey || !trees.isComplete) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    const isOrphan = (draft: DraftOnlyPresentation, listed: readonly ThreadDraftListItem[]) =>
      !listed.some((row) => row.itemKey === draft.itemKey);
    const orphans = presentations().filter((draft) => isOrphan(draft, drafts.drafts ?? []));
    if (orphans.length === 0) return;
    const attempt = new AbortController();
    const ended = async (draft: DraftOnlyPresentation) => {
      const metadata = await fetchCurrentDraftMetadata(queryClient, draft);
      if (attempt.signal.aborted) return;
      // An Apply from elsewhere may have reached the tree while the answer was on its way.
      if (latestTrees.current.find(draft.documentId)) {
        registry.promote(projectId, draft.documentId);
        return;
      }
      // An active draft the view still shows keeps the document (a delete's hold, a fresh
      // draft inside the `has_effect` lag). One the view let go of (a Discard of its last
      // change, which leaves the draft active and empty) has ended for this document.
      const pinned = views[draft.documentId]?.pin;
      const shown = pinned?.ownerKey === draft.ownerKey && pinned.itemKey === draft.itemKey;
      if (metadata.status !== "gone" && shown) return;
      // The answer is about this presentation: a newer mount of the item stays.
      if (registry.state(draft.token) !== "draft-only" || !removal) return;
      const successor = await successorDraft(queryClient, draft, pinned, scopeOwnerKey);
      if (attempt.signal.aborted) return;
      if (successor) setDocumentView(accountId, projectId, draft.documentId, { pin: successor });
      else {
        const closed = removal.discardDraft(projectId, draft.documentId);
        if (closed.kind !== "noop") notices?.presentedRemoved(projectId, closed.removed);
      }
      // Last: withdrawing changes the membership, which aborts this attempt.
      if (registry.isHold(draft.token)) registry.withdraw(draft.token);
    };
    for (const draft of orphans) {
      if (trees.find(draft.documentId)) {
        registry.promote(projectId, draft.documentId);
        // Every surface naming the item (main's address) learns that its draft ended.
        void fetchCurrentDraftMetadata(queryClient, draft).catch((error: unknown) =>
          reportError(error),
        );
        continue;
      }
      // slop-lint: allow swallowed-error an unanswered disposition keeps the document, never guesses Discard
      void ended(draft).catch(() => undefined);
    }
    return () => attempt.abort();
  }, [
    membership,
    drafts.drafts,
    drafts.status,
    projectId,
    queryClient,
    ownerKey,
    scopeOwnerKey,
    accountId,
    views,
    trees.isComplete,
    held,
  ]);

  // The list placing a presented document in the live tree makes it live for every host: a join,
  // New file, a link's Create, a restore, an Apply. While it shows the document in Trash or not
  // yet, the placement is not followed.
  const [, answered] = useReducer((count: number) => count + 1, 0);
  useEffect(() => standings.watch(projectId, answered), [standings, projectId]);
  useEffect(() => {
    if (drafts.status !== "ready") return;
    for (const draft of presentations()) {
      const listed = drafts.drafts?.some((row) => row.itemKey === draft.itemKey);
      if (listed && standings.standing(projectId, draft.documentId).kind === "in-tree")
        registry.promote(projectId, draft.documentId);
    }
  });

  return null;
}
