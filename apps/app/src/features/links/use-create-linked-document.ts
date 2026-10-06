/**
 * Creating the document a link addresses, from a follow that found nothing
 * there.
 *
 * The document goes at exactly the link's address: its scheme, its folders,
 * and its filename (with `.md` when the link omitted the extension). Only
 * manuscript, kb, and user documents are conjured by a link. Scratch notes are
 * made from a Work's Files tab or by the AI, and Uploads are files a writer
 * brings, so neither is creatable here.
 *
 * Built on the reservation and `setLocation` primitive, which commits locally
 * and syncs in the background; the server's move creates any missing folders.
 * A later sync failure lands on the document itself. Nothing about the link
 * changes on creation: the project now holds a document at that address, which
 * is a new catalog revision, and every resolution scope keyed on it asks again.
 */

import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import { parseContextUri } from "@meridian/contracts/context-uri";
import { useCallback, useRef, useState } from "react";

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
};

/** Where Create puts the document for this address, or null when it cannot. */
export function linkCreationTarget(address: string | null): LinkCreationTarget | null {
  if (!address) return null;
  const parsed = parseContextUri(address);
  if (!parsed.ok) return null;
  const { scheme, path } = parsed.value;
  if (!isCreatableLinkScheme(scheme)) return null;
  const folders = path.split("/");
  const leaf = folders.pop();
  if (!leaf) return null;
  const name = documentFileName(leaf);
  if (!name) return null;
  if (![...folders, name].every((segment) => validateContextEntryName(segment).ok)) return null;
  return { scheme, folderPath: folders.join("/"), name };
}

export type CreateLinkedDocument = {
  /** The new document's id, or null when it could not be created. */
  create(target: LinkCreationTarget): Promise<string | null>;
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
    async (target: LinkCreationTarget) => {
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
            workId: null,
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
