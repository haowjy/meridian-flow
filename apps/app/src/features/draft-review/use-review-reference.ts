import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { RoomDocs } from "@meridian/document-model";
import { useEffect, useId, useState } from "react";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { useOptionalLiveDocumentSessionRegistry } from "@/features/project/context/account-feature-context";
import type { ReviewMode } from "./review-mode";

export type ReviewAgainst =
  | { kind: "live" }
  | { kind: "draft"; draftId: string }
  | { kind: "file"; documentId: string };

export type ReviewReference =
  | { kind: "live" }
  | (Exclude<ReviewAgainst, { kind: "live" }> & { docs: RoomDocs | null });

export function referenceOf(target: string): ReviewAgainst {
  if (target === "live") return { kind: "live" };
  if (target.startsWith("file:")) return { kind: "file", documentId: target.slice(5) };
  return { kind: "draft", draftId: target };
}

/**
 * The reference room of a review against another draft or file, held open while the review
 * shows it: another draft's fork of this document, or the other file as this draft shows it (its
 * fork, or its Live room when the draft created it). Null docs until the room is open.
 */
export function useReviewReference(mode: ReviewMode | null): ReviewReference | null {
  const registry = useOptionalLiveDocumentSessionRegistry();
  const host = useId();
  const files = useOwnerDrafts(mode?.projectId ?? null, mode?.draftId ?? null).files;
  const [docs, setDocs] = useState<{ key: string; docs: RoomDocs } | null>(null);
  const target = mode ? referenceOf(mode.target) : null;
  const room =
    !mode || !target || target.kind === "live"
      ? null
      : target.kind === "draft"
        ? { documentId: mode.documentId, draftId: target.draftId }
        : {
            documentId: target.documentId,
            draftId: files?.some((file) => file.documentId === target.documentId && file.item.isNew)
              ? undefined
              : mode.draftId,
          };
  const projectId = mode?.projectId ?? null;
  const documentId = room?.documentId ?? null;
  const draftId = room?.draftId;
  const key = documentId ? `${documentId}:${draftId ?? "live"}` : null;
  useEffect(() => {
    if (!registry || !projectId || !documentId || !key) return;
    const owner = `review-reference:${host}:${key}`;
    const lease = registry.admit(
      projectId as ProjectId,
      documentId as DocumentId,
      draftId as DraftId | undefined,
    );
    registry.retain(owner, [lease]);
    setDocs({ key, docs: registry.get(lease).docs });
    return () => registry.release(owner);
  }, [registry, host, projectId, documentId, draftId, key]);
  if (!target) return null;
  if (target.kind === "live") return target;
  const held = docs?.key === key ? docs.docs : null;
  return { ...target, docs: held };
}
