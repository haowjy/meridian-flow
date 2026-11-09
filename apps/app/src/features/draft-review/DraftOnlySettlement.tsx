/** One project lifecycle owner settles remote dispositions for every Work with draft-only presentations. */

import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { resourceIdentityIndex } from "@meridian/resource-replica";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { contextCatalogScope } from "@/client/query/useContextCatalog";
import { fetchCurrentDraftMetadata } from "@/client/query/useDraftMetadata";
import { useWorkBranchDrafts } from "@/client/query/useWorkBranchDrafts";
import {
  useObservedResourceProjection,
  useOptionalAccountResourceReplica,
  useOptionalProjectContextAvailabilityCoordinator,
} from "@/features/project/context/account-feature-context";
import {
  type DraftOnlyContainer,
  type DraftOnlyPresentation,
  useDraftOnlyLifecycle,
} from "./draft-only-lifecycle";
import type { DraftRef } from "./review-command-types";

export function DraftOnlySettlement({ projectId }: { projectId: string }) {
  const lifecycle = useDraftOnlyLifecycle(projectId);
  // Primitive snapshot: a fresh presentation array is not an external-store change.
  useSyncExternalStore(
    lifecycle.subscribe,
    () => JSON.stringify(lifecycle.presentations(projectId)),
    () => "",
  );
  const presentations = lifecycle.presentations(projectId);
  const works = new Set(presentations.map((draft) => draft.workId));
  return [...works].map((workId) => (
    <WorkSettlement
      key={workId}
      projectId={projectId}
      workId={workId}
      lifecycle={lifecycle}
      membership={JSON.stringify(presentations.filter((draft) => draft.workId === workId))}
    />
  ));
}

function WorkSettlement({
  projectId,
  workId,
  lifecycle,
  membership,
}: {
  projectId: string;
  workId: string;
  lifecycle: DraftOnlyContainer;
  membership: string;
}) {
  const queryClient = useQueryClient();
  const resources = useOptionalAccountResourceReplica();
  const availability = useOptionalProjectContextAvailabilityCoordinator();
  const drafts = useWorkBranchDrafts(projectId, workId);
  const projection = useObservedResourceProjection(resources, projectId);
  // The pending list omits a draft with no effect (and one inside the
  // `has_effect` lag), so leaving it proves nothing. For an unlisted draft-only
  // tab the catalog decides first: a document that now exists was applied and
  // the tab goes live. Otherwise only the draft's own metadata may retire it: a
  // `gone` draft was discarded; an active one keeps its tab (a delete's hold).
  useEffect(() => {
    if (!resources || !projectId || !workId) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    const isOrphan = (draft: DraftRef, activeDrafts: readonly ThreadDraftListItem[]) =>
      draft.workId === workId && !activeDrafts.some((row) => row.itemKey === draft.itemKey);
    const activeDrafts = drafts.drafts ?? [];
    if (!lifecycle.presentations(projectId).some((draft) => isOrphan(draft, activeDrafts))) return;

    const scopeFor = (draft: DraftOnlyPresentation) =>
      contextCatalogScope(projectId, draft.contextLocation.scheme, { workId: draft.workId });
    const scopes = new Map(
      lifecycle
        .presentations(projectId)
        .filter((draft) => isOrphan(draft, activeDrafts))
        .flatMap((draft) => {
          const scope = scopeFor(draft);
          return scope ? [[JSON.stringify(scope), scope] as const] : [];
        }),
    );
    const attempt = new AbortController();
    // A catalog observation that starts now: joining an older in-flight one
    // could report the pre-Apply tree and misread a remote Apply as a Discard.
    for (const [key, scope] of scopes) {
      void resources
        .acquireCatalogAfter(projectId, scope)
        .then((view) => {
          if (attempt.signal.aborted) return;
          queryClient.setQueryData(projectQueryKeys.contextCatalog(projectId, scope), view);
          const currentDrafts =
            queryClient.getQueryData<ThreadDraftListItem[]>(
              projectQueryKeys.workBranchDrafts(projectId, workId),
            ) ?? [];
          for (const draft of lifecycle.presentations(projectId)) {
            if (!isOrphan(draft, currentDrafts) || JSON.stringify(scopeFor(draft)) !== key)
              continue;
            if (view.entries.get(draft.documentId)?.kind === "file") {
              void lifecycle.promote(draft);
              continue;
            }
            void fetchCurrentDraftMetadata(queryClient, draft)
              .then((metadata) => {
                if (attempt.signal.aborted || metadata.status !== "gone") return;
                const still = lifecycle
                  .presentations(projectId)
                  .find((entry) => entry.token === draft.token);
                if (still) lifecycle.remove(still);
              })
              // An unanswered disposition keeps the tab, never guesses Discard.
              .catch(() => undefined);
          }
        })
        // A failed membership check leaves this scope's tabs intact, never guesses Discard.
        .catch(() => undefined);
    }
    return () => attempt.abort();
  }, [
    lifecycle,
    membership,
    drafts.drafts,
    drafts.status,
    projectId,
    queryClient,
    resources,
    workId,
  ]);

  // Draft-only means "hidden live". The replica showing the document (by its
  // current id or an alias: a join, New file, a link's Create) makes it live at
  // once for every Work. Showing means placed: the replica keeps a deleted
  // document's record, and its draft stays draft-only until Apply brings it
  // back. The tab keeps its view and pin through promotion, so a review the writer was
  // looking at stays on screen over the live document.
  // Availability can apply a live delete before the replica hears of it: while
  // it says the document is removed, a still-placed record is stale and must
  // not undo the hold that just made the tab draft-only (D79).
  useEffect(() => {
    if (drafts.status !== "ready") return;
    const identities = resourceIdentityIndex(projection.records);
    const promoting = new Set<string>();
    for (const draft of lifecycle.presentations(projectId)) {
      const row = drafts.drafts?.find((candidate) => candidate.itemKey === draft.itemKey);
      const record = identities.byDocumentId(draft.documentId);
      if (draft.workId !== workId || !row || !record) continue;
      if (record.resource.lifecycle.kind === "terminal") continue;
      if (!projection.placement.resourceLocation(record)) continue;
      if (availability?.removalRecord(projectId, draft.documentId).get()?.kind === "removed")
        continue;
      if (promoting.has(draft.documentId)) continue;
      promoting.add(draft.documentId);
      void lifecycle.promote(draft);
    }
  }, [
    lifecycle,
    membership,
    drafts.drafts,
    drafts.status,
    projection.records,
    projection.placement,
    projectId,
    workId,
    availability,
  ]);

  return null;
}
