/** Trash entries: which exist is the lists' replay; the server adds when, by whom and how long. */
import type { ProjectContextTreeScheme, TrashEntryFacts } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { foldersAbove } from "@/core/tree-list/standing";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { getTrash, getTrashedDocument } from "../api/projects-api";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";
import { useAccountContextSources, useProjectContextSources } from "./useContextSources";
import { listIsComplete, useTreeList } from "./useProjectTree";

/**
 * One Trash entry: a document deleted on its own, or a deleted folder with what its delete took.
 * `kept` is the server's answer (when, by whom, how long it stays), null until it has come.
 */
export type TrashEntry = {
  /** The deleted document's or folder's id: what a restore names. */
  nodeId: string;
  kind: "document" | "folder";
  name: string;
  scheme: ProjectContextTreeScheme;
  /** The names of the folders it was deleted from, top first. */
  folders: readonly string[];
  /** The documents a folder's delete took with it; 0 for a document. */
  documents: number;
  kept: TrashEntryFacts | null;
};

/**
 * What is in Trash is a fact of the lists: an entry shows while the replay holds its delete in
 * force, so a delete shows at once, a restore leaves at once and a refused one comes back. Newest
 * first; an entry the server has not answered for yet is the newest. Null until the lists and the
 * sources have been read.
 */
export function useTrashRows(projectId: string): readonly TrashEntry[] | null {
  const accountId = useAccountId();
  const project = useTreeList(projectId ? { kind: "project", projectId } : null);
  const account = useTreeList({ kind: "account", userId: accountId });
  const projectSources = useProjectContextSources(projectId);
  const accountSources = useAccountContextSources();
  const versions = [project, account].map((list) => list.snapshot?.version);
  // The replay's input is each list's version.
  return useMemo(() => {
    if (!projectSources || !accountSources) return null;
    if (![project, account].every(({ session, snapshot }) => session && snapshot)) return null;
    if (![project, account].every(({ snapshot }) => snapshot && listIsComplete(snapshot.status)))
      return null;
    const schemes = new Map(
      [...projectSources, ...accountSources].map((source) => [source.id as string, source.scheme]),
    );
    // Two deletes of one node (two clients, or a folder deleted again) are one entry.
    const seen = new Set<string>();
    return [project, account].flatMap(({ session }) => {
      const projection = session?.replay();
      if (!projection) return [];
      return [...projection.trash].reverse().flatMap((entry): TrashEntry[] => {
        const node = projection.nodes.get(entry.node);
        const scheme = node && schemes.get(node.source);
        if (!node || node.purged || !scheme || seen.has(node.id)) return [];
        seen.add(node.id);
        return [
          {
            nodeId: node.id,
            kind: node.kind === "folder" ? "folder" : "document",
            name: node.name,
            scheme,
            folders: foldersAbove(projection, node),
            documents:
              node.kind === "folder"
                ? entry.cascade.filter((id) => {
                    const below = projection.nodes.get(id);
                    return below && below.kind !== "folder" && !below.purged;
                  }).length
                : 0,
            kept: null,
          },
        ];
      });
    });
  }, [project, account, projectSources, accountSources, ...versions]);
}

/**
 * The rows with the server's facts. The facts are read when Trash is first shown and again while
 * a row has none, after each change to a list (the server may not have admitted the delete the
 * first time), never for a change to anything else.
 */
export function useDocumentTrash(projectId: string) {
  const rows = useTrashRows(projectId);
  const query = useQuery({
    queryKey: projectQueryKeys.trash(projectId),
    queryFn: ({ signal }) => getTrash(projectId, { signal }),
    staleTime: 30_000,
  });
  const kept = useMemo(
    () => new Map((query.data?.entries ?? []).map((entry) => [entry.nodeId, entry])),
    [query.data],
  );
  const { refetch } = query;
  // `rows` changes with the lists, not with the facts: an unanswered row asks again per change.
  useEffect(() => {
    if (rows?.some((row) => !kept.has(row.nodeId))) void refetch({ cancelRefetch: false });
  }, [rows, refetch]);
  const data = useMemo(() => {
    if (!rows) return undefined;
    const withKept = rows.map((row) => ({ ...row, kept: kept.get(row.nodeId) ?? null }));
    const unanswered = withKept.filter((row) => !row.kept);
    const answered = withKept
      .filter((row) => row.kept)
      .sort((a, b) => (b.kept?.removal.time ?? "").localeCompare(a.kept?.removal.time ?? ""));
    return { entries: [...unanswered, ...answered] };
  }, [rows, kept]);
  return { data, isError: query.isError, isPending: !data, refetch: query.refetch };
}

export function useTrashedDocument(projectId: string, documentId: string | null) {
  return useQuery({
    queryKey: projectQueryKeys.trashedDocument(projectId, documentId ?? ""),
    queryFn: ({ signal }) => getTrashedDocument(projectId, documentId as string, { signal }),
    enabled: projectReadEnabled(documentId !== null),
    staleTime: 30_000,
  });
}
