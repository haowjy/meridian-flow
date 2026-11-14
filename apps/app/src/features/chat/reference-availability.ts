/**
 * Whether the documents and folders a chat's writer messages reference still exist: what an exact
 * `@` reference chip draws (filled, or dashed and unfollowable once its document or folder is
 * gone). Read from the replay of the project's list, so a delete or rename made anywhere shows at
 * once and nothing is asked.
 */

import { useMemo } from "react";
import { useProjectTrees } from "@/client/query/useProjectTrees";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import type { TranscriptReferenceResolution } from "@/rich-content/TranscriptReference";

const NOTHING: ReadonlyMap<string, TranscriptReferenceResolution> = new Map();

/**
 * The exact-reference answers a user turn draws, for the identities it references. Until the list
 * has been read, or outside a project, nothing is known: chips stay filled and do not follow.
 */
export function useReferenceAvailability(
  keys: readonly string[],
): ReadonlyMap<string, TranscriptReferenceResolution> {
  const projectId = useProjectDocumentNavigationProjectId();
  const trees = useProjectTrees(projectId ?? "", { account: true });
  const key = keys.join("\u0000");
  return useMemo(() => {
    if (!projectId || !trees.isComplete || !key) return NOTHING;
    const answers = new Map<string, TranscriptReferenceResolution>();
    for (const each of key.split("\u0000")) {
      if (each.startsWith("folder:")) {
        const folderId = each.slice("folder:".length);
        const found = trees.sources
          .map((source) => trees.tree(source.id)?.entry(folderId))
          .find((entry) => entry?.kind === "dir");
        answers.set(
          each,
          found
            ? { kind: "folder", id: folderId, uri: found.uri, label: found.name, available: true }
            : { kind: "folder", id: folderId, available: false },
        );
        continue;
      }
      const documentId = each.slice("document:".length);
      const place = trees.find(documentId);
      answers.set(
        each,
        place
          ? {
              kind: "document",
              id: documentId,
              uri: place.file.uri,
              label: place.file.name,
              available: true,
            }
          : { kind: "document", id: documentId, available: false },
      );
    }
    return answers;
  }, [projectId, trees, key]);
}
