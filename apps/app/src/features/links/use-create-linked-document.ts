/**
 * Creating the document a wikilink names, from a follow that found nothing.
 *
 * A wikilink resolves by title, and a document's title is its filename without
 * the extension, so the document is `manuscript://<name>.md`. Nothing about the
 * link changes on creation: the project now holds a document it did not, which
 * is a new catalog revision, and every resolution scope keyed on it asks again.
 * No cache is poked from here.
 */

import { useCallback, useState } from "react";

import { useAccountResourceReplica } from "@/features/project/context/account-feature-context";

export type CreateLinkedDocument = {
  /** The new document's id, or null when it could not be created. */
  create(name: string): Promise<string | null>;
  creating: boolean;
  failed: boolean;
};

export function useCreateLinkedDocument(projectId: string | null): CreateLinkedDocument {
  const resources = useAccountResourceReplica();
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(false);

  const create = useCallback(
    async (name: string) => {
      if (!projectId) return null;
      setFailed(false);
      setCreating(true);
      let documentId: string | null = null;
      try {
        const reservation = await resources.reserveDocument(projectId);
        if (reservation.content.kind !== "opened")
          throw new Error("Local document content is unavailable");
        documentId = reservation.content.handle.documentId;
        try {
          await resources.setLocation(projectId, reservation.key, {
            scheme: "manuscript",
            folderPath: "",
            name: `${name}.md`,
            workId: null,
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
    [projectId, resources],
  );

  return { create, creating, failed };
}
