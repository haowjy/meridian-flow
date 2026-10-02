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
 * A later sync failure lands on the document itself. No Work's Scratch is the
 * one area the local replica cannot place a document in (its namespace
 * protocol names a Work by slug, and No Work has none), so there Create asks
 * the server first, the way the Scratch tree's own New file does. Nothing about the link
 * changes on creation: the project now holds a document at that address, which
 * is a new catalog revision, and every resolution scope keyed on it asks again.
 */

import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import { type ParsedContextAuthority, parseContextUri } from "@meridian/contracts/context-uri";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { createContextEntry } from "@/client/api/projects-api";
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
          (isNoWorkScratch(target, work) && !noWorkId)
        ) {
          const snapshot = await queryClient.ensureQueryData({
            queryKey: projectQueryKeys.works(projectId),
            queryFn: () => acquireWorksSnapshot(queryClient, projectId),
          });
          noWorkId = snapshot.noWork.id;
          work = scratchWork(target, workId, snapshot.works, noWorkId);
        }
        if (work === "unknown") throw new Error("The address names no Work this project has");
        if (isNoWorkScratch(target, work)) {
          if (!noWorkId) throw new Error("No Work is not known yet");
          documentId = await createOnServer(projectId, target, noWorkId);
          void queryClient.invalidateQueries({
            queryKey: projectQueryKeys.contextCatalogView(projectId, "scratch", noWorkId),
          });
        } else {
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

function isNoWorkScratch(
  target: LinkCreationTarget,
  work: ReturnType<typeof scratchWork>,
): boolean {
  return target.scheme === "scratch" && work !== "unknown" && work.workId === null;
}

async function createOnServer(
  projectId: string,
  target: LinkCreationTarget,
  noWorkId: string,
): Promise<string> {
  const path = [target.folderPath, target.name].filter(Boolean).join("/");
  const result = await createContextEntry(
    projectId,
    "scratch",
    { type: "file", path },
    {
      workId: noWorkId,
    },
  );
  if (result.status !== "created" || !result.documentId)
    throw new Error("No Work Scratch document was not created");
  return result.documentId;
}

/**
 * The Work a Scratch document is created in. No Work travels as a null Work id
 * (the server resolves the locked row); a named Work needs its slug too, or the
 * move can never validate its canonical address. "unknown" when the list does
 * not name the Work (or has not loaded).
 */
export function scratchWork(
  target: LinkCreationTarget,
  surfaceWorkId: string | null,
  works: WorkList | null,
  noWorkId: string | null,
): { workId: string | null; workSlug?: string } | "unknown" {
  if (target.scheme !== "scratch" || target.authority.kind === "none") return { workId: null };
  const { authority } = target;
  if (authority.kind === "contextual" && (!surfaceWorkId || surfaceWorkId === noWorkId))
    return { workId: null };
  const work = works?.find((candidate) =>
    authority.kind === "work"
      ? candidate.slug === authority.workSlug
      : candidate.id === surfaceWorkId,
  );
  return work?.slug ? { workId: work.id, workSlug: work.slug } : "unknown";
}
