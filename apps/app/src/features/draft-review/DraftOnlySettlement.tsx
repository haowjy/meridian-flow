/** Settles every draft-only document the project's hosts present, one owner's drafts at a time. */

import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { resourceIdentityIndex } from "@meridian/resource-replica";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { contextCatalogScope } from "@/client/query/useContextCatalog";
import { fetchCurrentDraftMetadata } from "@/client/query/useDraftMetadata";
import { cachedOwnerDrafts, catalogOwnerOf, useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import {
  useObservedResourceProjection,
  useOptionalAccountResourceReplica,
  useOptionalContextRemovalCoordinator,
  useOptionalDraftOnlyPresentations,
  useOptionalProjectContextAvailabilityCoordinator,
  useOptionalRemovedNotices,
} from "@/features/project/context/account-feature-context";
import type { DraftOnlyPresentation, DraftOnlyPresentations } from "./draft-only-presentations";

const NONE: readonly DraftOnlyPresentation[] = [];

export function DraftOnlySettlement({ projectId }: { projectId: string }) {
  const registry = useOptionalDraftOnlyPresentations();
  const presentations = useSyncExternalStore(
    registry?.subscribe ?? (() => () => undefined),
    () => registry?.presentations(projectId) ?? NONE,
    () => NONE,
  );
  if (!registry) return null;
  const owners = new Set(presentations.map((draft) => draft.ownerKey));
  return [...owners].map((ownerKey) => (
    <OwnerSettlement
      key={ownerKey}
      projectId={projectId}
      ownerKey={ownerKey}
      registry={registry}
      membership={JSON.stringify(presentations.filter((draft) => draft.ownerKey === ownerKey))}
    />
  ));
}

function OwnerSettlement({
  projectId,
  ownerKey,
  registry,
  membership,
}: {
  projectId: string;
  ownerKey: string;
  registry: DraftOnlyPresentations;
  membership: string;
}) {
  const queryClient = useQueryClient();
  const resources = useOptionalAccountResourceReplica();
  const availability = useOptionalProjectContextAvailabilityCoordinator();
  const removal = useOptionalContextRemovalCoordinator();
  const notices = useOptionalRemovedNotices();
  const drafts = useOwnerDrafts(projectId, ownerKey);
  const projection = useObservedResourceProjection(resources, projectId);
  const presentations = () =>
    registry.presentations(projectId).filter((draft) => draft.ownerKey === ownerKey);
  // A presentation whose draft is listed again live, then looked up: one lookup per sighting.
  const lookedUp = useRef(new Set<string>());
  // The pending list omits a draft with no effect (and one inside the `has_effect` lag), so
  // leaving it proves nothing. For an unlisted presentation the catalog decides first: a
  // document that now exists was applied and its hosts go live. Otherwise only the draft's own
  // metadata may close it: a `gone` draft was discarded; an active one keeps it (a delete's hold).
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
              void fetchCurrentDraftMetadata(queryClient, draft).catch(() => undefined);
              continue;
            }
            void fetchCurrentDraftMetadata(queryClient, draft)
              .then((metadata) => {
                if (attempt.signal.aborted || metadata.status !== "gone") return;
                // The answer is about this mount's presentation: a newer one of the item stays.
                if (registry.state(draft.token) !== "draft-only" || !removal) return;
                const closed = removal.discardDraft(projectId, draft.documentId);
                if (closed.kind !== "noop") notices?.presentedRemoved(projectId, closed.removed);
              })
              // An unanswered disposition keeps the document, never guesses Discard.
              .catch(() => undefined);
          }
        })
        // A failed membership check leaves this scope's documents open, never guesses Discard.
        .catch(() => undefined);
    }
    return () => attempt.abort();
  }, [membership, drafts.drafts, drafts.status, projectId, queryClient, resources, ownerKey]);

  // The replica placing a presented document (by its current id or an alias: a join, New file, a
  // link's Create, a restore) makes it live for every host. Availability can apply a live delete
  // before the replica hears of it, so while availability says `removed` a placed record may be
  // stale: the document is looked up again, and only an `available` answer promotes.
  useEffect(() => {
    if (drafts.status !== "ready") return;
    const identities = resourceIdentityIndex(projection.records);
    for (const draft of presentations()) {
      const listed = drafts.drafts?.some((row) => row.itemKey === draft.itemKey);
      const record = identities.byDocumentId(draft.documentId);
      const sighting = `${draft.token}|${draft.documentId}`;
      const placed =
        !!record &&
        record.resource.lifecycle.kind !== "terminal" &&
        !!projection.placement.resourceLocation(record);
      if (!placed) {
        lookedUp.current.delete(sighting);
        continue;
      }
      if (!listed) continue;
      if (availability?.removalRecord(projectId, draft.documentId).get()?.kind !== "removed") {
        registry.promote(projectId, draft.documentId);
        continue;
      }
      if (lookedUp.current.has(sighting)) continue;
      lookedUp.current.add(sighting);
      void availability.resolveForOpen(projectId, draft.documentId).then((answer) => {
        if (answer.kind === "available") registry.promote(projectId, draft.documentId);
      });
    }
  }, [
    membership,
    drafts.drafts,
    drafts.status,
    projection.records,
    projection.placement,
    projectId,
    availability,
  ]);

  return null;
}
