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
 * changes on creation: the project now holds a document at that address, which
 * is a new catalog revision, and every resolution scope keyed on it asks again.
 */

import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import { type ParsedContextAuthority, parseContextUri } from "@meridian/contracts/context-uri";
import { useCallback, useState } from "react";

import { useWorks } from "@/client/query/useWorks";
import { documentFileName } from "@/core/editor/links";
import { useAccountResourceReplica } from "@/features/project/context/account-feature-context";

const CREATABLE_SCHEMES = ["manuscript", "kb", "user", "scratch"] as const;
type CreatableScheme = (typeof CREATABLE_SCHEMES)[number];

export type LinkCreationTarget = {
  scheme: CreatableScheme;
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
  if (!(CREATABLE_SCHEMES as readonly string[]).includes(scheme)) return null;
  const folders = path.split("/");
  const leaf = folders.pop();
  if (!leaf) return null;
  const name = documentFileName(leaf);
  if (![...folders, name].every((segment) => validateContextEntryName(segment).ok)) return null;
  return { scheme: scheme as CreatableScheme, folderPath: folders.join("/"), name, authority };
}

export type CreateLinkedDocument = {
  /** The new document's id, or null when it could not be created. */
  create(target: LinkCreationTarget): Promise<string | null>;
  creating: boolean;
  failed: boolean;
};

/**
 * `workId` is the surface's Work (a named Work or the No Work row, null for No
 * Work): what a contextual `scratch://` address means there.
 */
export function useCreateLinkedDocument(
  projectId: string | null,
  workId: string | null,
): CreateLinkedDocument {
  const resources = useAccountResourceReplica();
  const { works, noWork } = useWorks(projectId ?? "", { enabled: Boolean(projectId) });
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(false);

  const create = useCallback(
    async (target: LinkCreationTarget) => {
      if (!projectId) return null;
      setFailed(false);
      setCreating(true);
      let documentId: string | null = null;
      try {
        const work = scratchWork(target, workId, works, noWork?.id ?? null);
        if (work === "unknown") throw new Error("The address names no Work this project has");
        const reservation = await resources.reserveDocument(projectId);
        if (reservation.content.kind !== "opened")
          throw new Error("Local document content is unavailable");
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
      } finally {
        setCreating(false);
      }
      if (!documentId) setFailed(true);
      return documentId;
    },
    [noWork?.id, projectId, resources, workId, works],
  );

  return { create, creating, failed };
}

/**
 * The Work a Scratch document is created in. No Work travels as a null Work id
 * (the server resolves the locked row); a named Work needs its slug too, or the
 * move can never validate its canonical address.
 */
export function scratchWork(
  target: LinkCreationTarget,
  surfaceWorkId: string | null,
  works: readonly { id: string; slug: string | null }[] | null,
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
