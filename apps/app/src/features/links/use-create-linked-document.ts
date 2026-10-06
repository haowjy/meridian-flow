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
 * Whether the address can be created at all, and whether its Work can take a
 * note, is decided up front (`planLinkCreation`), when the dialog is shown, so
 * Create is only ever offered where it can succeed.
 * A later sync failure lands on the document itself. Nothing about the link
 changes on creation: the project now holds a document at that address, which
 * is a new catalog revision, and every resolution scope keyed on it asks again.
 */

import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import { type ParsedContextAuthority, parseContextUri } from "@meridian/contracts/context-uri";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { type ResourceWorkAuthority, resourceWorkAuthorityFor } from "@meridian/resource-replica";
import { useCallback, useMemo, useRef, useState } from "react";

import { useWorks } from "@/client/query/useWorks";
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
function linkCreationTarget(address: string | null): LinkCreationTarget | null {
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

/**
 * What the dialog can offer for a missing address, decided once from the
 * Works snapshot: Create (with the Work it lands in), Unarchive first (an
 * archived Work takes no new notes), or nothing. `loading` is a Scratch
 * address whose Work the snapshot has not delivered yet.
 */
export type LinkCreation =
  | { kind: "create"; target: LinkCreationTarget; work: ResourceWorkAuthority }
  | { kind: "archived"; target: LinkCreationTarget; work: Work }
  | { kind: "loading"; target: LinkCreationTarget };

/**
 * `surfaceWorkId` is the surface's Work (a named Work or the No Work row; null
 * while unresolved): what a contextual `scratch://` address means there.
 * `snapshot` is the live Works (deleted ones absent), or null while loading.
 * A Work that is deleted, or that no Work has the name of, offers nothing.
 */
export function planLinkCreation(
  address: string | null,
  surfaceWorkId: string | null,
  snapshot: { works: readonly Work[]; noWork: Work } | null,
): LinkCreation | null {
  const target = linkCreationTarget(address);
  if (!target) return null;
  if (target.scheme !== "scratch") return { kind: "create", target, work: { workId: null } };
  const { authority } = target;
  if (!snapshot || (authority.kind === "contextual" && !surfaceWorkId))
    return { kind: "loading", target };
  const work =
    authority.kind === "none"
      ? snapshot.noWork
      : authority.kind === "contextual"
        ? [snapshot.noWork, ...snapshot.works].find(({ id }) => id === surfaceWorkId)
        : snapshot.works.find(({ slug }) => slug === authority.workSlug);
  if (!work) return null;
  if (isWorkArchived(work)) return { kind: "archived", target, work };
  return { kind: "create", target, work: resourceWorkAuthorityFor(work.id, snapshot) };
}

/** `planLinkCreation` over the project's Works as this surface sees them. */
export function useLinkCreation(
  projectId: string | null,
  workId: string | null,
  address: string | null,
): LinkCreation | null {
  const { works, noWork } = useWorks(projectId ?? "", { enabled: Boolean(projectId) });
  return useMemo(
    () => planLinkCreation(address, workId, works && noWork ? { works, noWork } : null),
    [address, workId, works, noWork],
  );
}

export type CreateLinkedDocument = {
  /** The new document's id, or null when it could not be created. */
  create(creation: Extract<LinkCreation, { kind: "create" }>): Promise<string | null>;
  creating: boolean;
  failed: boolean;
};

export function useCreateLinkedDocument(projectId: string | null): CreateLinkedDocument {
  const resources = useAccountResourceReplica();
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(false);
  // State lands a render late; a second press in the same tick must not
  // reserve a second document.
  const inFlight = useRef(false);

  const create = useCallback(
    async ({ target, work }: Extract<LinkCreation, { kind: "create" }>) => {
      if (!projectId || inFlight.current) return null;
      inFlight.current = true;
      setFailed(false);
      setCreating(true);
      let documentId: string | null = null;
      let reserved: { key: Parameters<typeof resources.deleteDocument>[1] } | null = null;
      try {
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
    [projectId, resources],
  );

  return { create, creating, failed };
}
