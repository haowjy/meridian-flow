/** Settles every draft-only document the project's hosts present, one owner's drafts at a time. */

import { draftOwnerKey, type ThreadDraftListItem } from "@meridian/contracts/branches";
import { resourceIdentityIndex } from "@meridian/resource-replica";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useSyncExternalStore } from "react";
import {
  type DraftPin,
  setDocumentView,
  useDocumentViews,
} from "@/client/project-shell/document-views";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { contextCatalogScope } from "@/client/query/useContextCatalog";
import { fetchCurrentDraftMetadata } from "@/client/query/useDraftMetadata";
import {
  cachedOwnerDrafts,
  catalogOwnerOf,
  ownerDraftsQueryOptions,
  useOwnerDrafts,
} from "@/client/query/useOwnerDrafts";
import {
  useAccountId,
  useObservedResourceProjection,
  useOptionalAccountResourceReplica,
  useOptionalContextRemovalCoordinator,
  useOptionalDraftOnlyPresentations,
  useOptionalProjectContextAvailabilityCoordinator,
  useOptionalRemovedNotices,
} from "@/features/project/context/account-feature-context";
import { useWorkScopeState } from "@/features/project/use-work-scope";
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
  const { workId } = useWorkScopeState(projectId);
  const scopeOwnerKey = workId ? draftOwnerKey({ kind: "work", workId }) : "";
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
  const resources = useOptionalAccountResourceReplica();
  const availability = useOptionalProjectContextAvailabilityCoordinator();
  const removal = useOptionalContextRemovalCoordinator();
  const notices = useOptionalRemovedNotices();
  const drafts = useOwnerDrafts(projectId, ownerKey);
  const views = useDocumentViews(accountId, projectId);
  const projection = useObservedResourceProjection(resources, projectId);
  const presentations = () =>
    registry.presentations(projectId).filter((draft) => draft.ownerKey === ownerKey);
  // The pending list omits a draft with no effect (and one inside the `has_effect` lag), so
  // leaving it proves nothing. For an unlisted presentation the catalog decides first: a
  // document that now exists was applied and its hosts go live. Otherwise only the draft's own
  // metadata and the document's view may end it. A document that another draft (the view's new
  // pick, the scope's, or one still held) also has paints that one; only one no draft has closes.
  useEffect(() => {
    if (!resources || !projectId || !ownerKey) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    const isOrphan = (draft: DraftOnlyPresentation, listed: readonly ThreadDraftListItem[]) =>
      !listed.some((row) => row.itemKey === draft.itemKey);
    const orphans = presentations().filter((draft) => isOrphan(draft, drafts.drafts ?? []));
    if (orphans.length === 0) return;
    const scopeFor = (draft: DraftOnlyPresentation) =>
      contextCatalogScope(projectId, draft.contextLocation.scheme, catalogOwnerOf(ownerKey));
    const scopes = new Map(
      orphans.flatMap((draft) => {
        const scope = scopeFor(draft);
        return scope ? [[JSON.stringify(scope), scope] as const] : [];
      }),
    );
    const attempt = new AbortController();
    const ended = async (draft: DraftOnlyPresentation) => {
      const metadata = await fetchCurrentDraftMetadata(queryClient, draft);
      if (attempt.signal.aborted) return;
      // An active draft the view still shows keeps the document (a delete's hold, a fresh
      // draft inside the `has_effect` lag). One the view let go of (a Discard of its last
      // change, which leaves the draft active and empty) has ended for this document.
      const pinned = views[draft.documentId]?.pin;
      const shown = pinned?.ownerKey === draft.ownerKey && pinned.itemKey === draft.itemKey;
      if (metadata.status !== "gone" && shown) return;
      // The answer is about this presentation: a newer mount of the item stays.
      if (registry.state(draft.token) !== "draft-only" || !removal) return;
      if (registry.isHold(draft.token)) registry.withdraw(draft.token);
      const successor = await successorDraft(queryClient, draft, pinned, scopeOwnerKey);
      if (attempt.signal.aborted) return;
      if (successor) {
        setDocumentView(accountId, projectId, draft.documentId, { pin: successor });
        return;
      }
      const closed = removal.discardDraft(projectId, draft.documentId);
      if (closed.kind !== "noop") notices?.presentedRemoved(projectId, closed.removed);
    };
    // A catalog observation that starts now: joining an older in-flight one could report the
    // pre-Apply tree and misread a remote Apply as a Discard.
    for (const [key, scope] of scopes) {
      void resources
        .acquireCatalogAfter(projectId, scope)
        .then((view) => {
          if (attempt.signal.aborted) return;
          queryClient.setQueryData(projectQueryKeys.contextCatalog(projectId, scope), view);
          const listed = cachedOwnerDrafts(queryClient, projectId, ownerKey) ?? [];
          for (const draft of presentations()) {
            if (!isOrphan(draft, listed) || JSON.stringify(scopeFor(draft)) !== key) continue;
            if (view.entries.get(draft.documentId)?.kind === "file") {
              registry.promote(projectId, draft.documentId);
              // Every surface naming the item (main's address) learns that its draft ended.
              void fetchCurrentDraftMetadata(queryClient, draft).catch((error: unknown) =>
                reportError(error),
              );
              continue;
            }
            // An unanswered disposition keeps the document, never guesses Discard.
            void ended(draft).catch(() => undefined);
          }
        })
        // A failed membership check leaves this scope's documents open, never guesses Discard.
        .catch(() => undefined);
    }
    return () => attempt.abort();
  }, [
    membership,
    drafts.drafts,
    drafts.status,
    projectId,
    queryClient,
    resources,
    ownerKey,
    scopeOwnerKey,
    accountId,
    views,
  ]);

  // The replica placing a presented document (by its current id or an alias: a join, New file, a
  // link's Create, a restore) makes it live for every host. Availability can apply a live delete
  // before the replica hears of it, so while availability says the document is removed the
  // placement may be stale: the answer is followed, not remembered. A placement asks once for a
  // fresh answer; a failed lookup is retried by availability's watch, and whatever answers next
  // re-runs this effect. Only `available` (or no answer at all) promotes.
  const [answers, answered] = useReducer((count: number) => count + 1, 0);
  const asked = useRef(new Set<string>());
  // Held across runs: releasing the last ask forgets an `unresolved` answer, which reads as none.
  const watched = useRef(new Map<string, () => void>());
  useEffect(() => {
    if (drafts.status !== "ready") return;
    const identities = resourceIdentityIndex(projection.records);
    const waiting = new Set<string>();
    for (const draft of presentations()) {
      const listed = drafts.drafts?.some((row) => row.itemKey === draft.itemKey);
      const record = identities.byDocumentId(draft.documentId);
      const sighting = `${draft.token}|${draft.documentId}`;
      const placed =
        !!record &&
        record.resource.lifecycle.kind !== "terminal" &&
        !!projection.placement.resourceLocation(record);
      if (!placed) {
        asked.current.delete(sighting);
        continue;
      }
      if (!listed) continue;
      const handle = availability?.removalRecord(projectId, draft.documentId);
      const answer = handle?.get()?.kind;
      if (!availability || !handle || (answer !== "removed" && answer !== "unresolved")) {
        registry.promote(projectId, draft.documentId);
        continue;
      }
      waiting.add(draft.documentId);
      if (!watched.current.has(draft.documentId))
        watched.current.set(draft.documentId, handle.subscribe(answered));
      if (answer === "removed" && !asked.current.has(sighting)) {
        asked.current.add(sighting);
        availability.removalOutdated(projectId, draft.documentId);
      }
    }
    for (const [documentId, release] of watched.current) {
      if (waiting.has(documentId)) continue;
      watched.current.delete(documentId);
      release();
    }
  }, [
    membership,
    drafts.drafts,
    drafts.status,
    projection.records,
    projection.placement,
    projectId,
    availability,
    answers,
  ]);
  useEffect(
    () => () => {
      for (const release of watched.current.values()) release();
      watched.current.clear();
    },
    [],
  );

  return null;
}
