/**
 * Creating the document a link addresses, from a follow that found nothing
 * there.
 *
 * The document goes at exactly the link's address: its scheme, its folders,
 * its filename (with `.md` when the link omitted the extension), and for
 * Scratch the Work its authority names (`@slug`, `@/` for No Work, or the
 * surface's own Work for a contextual `scratch://`). Uploads are files a writer
 * brings, never documents a link conjures, so they are not creatable here.
 *
 * Built on the reservation and `setLocation` primitive, which commits locally
 * and syncs in the background; the server's move creates any missing folders.
 * A later sync failure lands on the document itself. Nothing about the link
 changes on creation: the project now holds a document at that address, which
 * is a new catalog revision, and every resolution scope keyed on it asks again.
 */

import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import { type ParsedContextAuthority, parseContextUri } from "@meridian/contracts/context-uri";
import { type ResourceWorkAuthority, resourceWorkAuthorityFor } from "@meridian/resource-replica";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useWorks } from "@/client/query/useWorks";
import { acquireWorksSnapshot } from "@/client/query/works-projection-acquisition";
import {
  type CreatableLinkScheme,
  documentFileName,
  isCreatableLinkScheme,
} from "@/core/editor/links";
import { useAccountResourceReplica } from "@/features/project/context/account-feature-context";

export type LinkCreationTarget = {
  scheme: CreatableLinkScheme;
  folderPath: string;
  name: string;
  authority: ParsedContextAuthority;
};

/** Where Create puts the document for this address, or null when it cannot. */
export function linkCreationTarget(address: string | null): LinkCreationTarget | null {
  if (!address) return null;
  const parsed = parseContextUri(address);
  if (!parsed.ok) return null;
  const { scheme, path, authority } = parsed.value;
  if (!isCreatableLinkScheme(scheme)) return null;
  const folders = path.split("/");
  const leaf = folders.pop();
  if (!leaf) return null;
  const name = documentFileName(leaf);
  if (!name) return null;
  if (![...folders, name].every((segment) => validateContextEntryName(segment).ok)) return null;
  return { scheme, folderPath: folders.join("/"), name, authority };
}

export type CreateLinkedDocument = {
  /** The new document's id, or null when it could not be created. */
  create(target: LinkCreationTarget): Promise<string | null>;
  creating: boolean;
  failed: boolean;
};

type WorkList = readonly { id: string; slug: string | null }[];

/**
 * `workId` is the surface's Work (a named Work or the No Work row, null for No
 * Work): what a contextual `scratch://` address means there.
 */
export function useCreateLinkedDocument(
  projectId: string | null,
  workId: string | null,
): CreateLinkedDocument {
  const resources = useAccountResourceReplica();
  const queryClient = useQueryClient();
  const { works, noWork } = useWorks(projectId ?? "", { enabled: Boolean(projectId) });
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(false);
  // State lands a render late; a second press in the same tick must not
  // reserve a second document.
  const inFlight = useRef(false);

  const create = useCallback(
    async (target: LinkCreationTarget) => {
      if (!projectId || inFlight.current) return null;
      inFlight.current = true;
      setFailed(false);
      setCreating(true);
      let documentId: string | null = null;
      let reserved: { key: Parameters<typeof resources.deleteDocument>[1] } | null = null;
      try {
        let noWorkId = noWork?.id ?? null;
        let work = scratchWork(target, workId, works, noWorkId);
        // The Works list is still loading: a slug it will name is not missing.
        if (
          (work === "unknown" && works === null) ||
          (target.scheme === "scratch" && work !== "unknown" && work.workId === null)
        ) {
          const snapshot = await queryClient.ensureQueryData({
            queryKey: projectQueryKeys.works(projectId),
            queryFn: () => acquireWorksSnapshot(queryClient, projectId),
          });
          noWorkId = snapshot.noWork.id;
          work = scratchWork(target, workId, snapshot.works, noWorkId);
        }
        if (work === "unknown") throw new Error("The address names no Work this project has");
        const reservation = await resources.reserveDocument(projectId);
        if (reservation.content.kind !== "opened")
          throw new Error("Local document content is unavailable");
        reserved = { key: reservation.key };
        documentId = reservation.content.handle.documentId;
        try {
          await resources.setLocation(projectId, reservation.key, {
            scheme: target.scheme,
            folderPath: target.folderPath,
            name: target.name,
            ...work,
          });
        } finally {
          reservation.content.handle.release();
        }
      } catch {
        documentId = null;
        // A reservation that never reached its address is discarded, not left
        // in the tree as "Untitled N". It was never submitted, so the delete
        // settles locally.
        if (reserved) await resources.deleteDocument(projectId, reserved.key).catch(() => {});
      } finally {
        inFlight.current = false;
        setCreating(false);
      }
      if (!documentId) setFailed(true);
      return documentId;
    },
    [noWork?.id, projectId, queryClient, resources, workId, works],
  );

  return { create, creating, failed };
}

/** Resolve Scratch authority to its row id and canonical URI slug (null for No Work). */
function scratchWork(
  target: LinkCreationTarget,
  surfaceWorkId: string | null,
  works: WorkList | null,
  noWorkId: string | null,
): ResourceWorkAuthority | "unknown" {
  if (target.scheme !== "scratch") return { workId: null };
  if (target.authority.kind === "none")
    return noWorkId ? resourceWorkAuthorityFor(noWorkId, works, noWorkId) : { workId: null };
  const { authority } = target;
  if (authority.kind === "contextual" && (!surfaceWorkId || surfaceWorkId === noWorkId))
    return noWorkId ? resourceWorkAuthorityFor(noWorkId, works, noWorkId) : { workId: null };
  const work = works?.find((candidate) =>
    authority.kind === "work"
      ? candidate.slug === authority.workSlug
      : candidate.id === surfaceWorkId,
  );
  return work ? resourceWorkAuthorityFor(work.id, works, noWorkId) : "unknown";
}
