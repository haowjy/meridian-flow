import { useMemo } from "react";
import { useProjectTrees } from "@/client/query/useProjectTrees";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import type { TranscriptReferenceResolution } from "@/rich-content/TranscriptReference";

const NOTHING: ReadonlyMap<string, TranscriptReferenceResolution> = new Map();

export function useReferenceAvailability(
  keys: readonly string[],
): ReadonlyMap<string, TranscriptReferenceResolution> {
  const projectId = useProjectDocumentNavigationProjectId();
  const trees = useProjectTrees(projectId ?? "");
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
