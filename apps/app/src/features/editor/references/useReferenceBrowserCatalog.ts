import { useEffect, useMemo, useRef } from "react";
import { useIsProjectPendingCreation } from "@/client/query/useProjectCreation";
import { sourceFor } from "@/client/query/useProjectTree";
import { useProjectTrees } from "@/client/query/useProjectTrees";
import { useWorks } from "@/client/query/useWorks";
import {
  type ReferenceSourceView,
  type ReferenceWork,
  referenceRowForFile,
  referenceRowForFolder,
  referenceSourceOf,
} from "@/core/completion";
import type { ReferenceBrowserCatalog } from "@/core/editor/extensions/at-reference";
import { useAccountId } from "@/features/project/context/account-feature-context";

export function useReferenceBrowserCatalog(
  projectId: string | null | undefined,
  workId: string | null | undefined,
  label: string,
  /** A No Work chat's lineage: its Scratch joins the Work's in the browser. */
  rootThreadId?: string | null,
  /** The chat whose uploads the picker offers: a subagent's top chat. */
  chatId?: string | null,
): ReferenceBrowserCatalog | null {
  const accountId = useAccountId();
  const projectPending = useIsProjectPendingCreation(projectId);
  const trees = useProjectTrees(projectId ?? "", { account: true });
  const { works } = useWorks(projectId ?? "", { enabled: Boolean(projectId) });
  const workNames = useMemo(
    () => new Map<string, string>(works?.map((work) => [work.id, work.name])),
    [works],
  );

  const warmSources = useMemo(
    () =>
      [
        sourceFor(trees.sources, "manuscript", {}),
        sourceFor(trees.sources, "kb", {}),
        sourceFor(trees.sources, "user", {}),
        sourceFor(trees.sources, "scratch", { workId, rootThreadId }),
        sourceFor(trees.sources, "uploads", { chatId }),
      ].flatMap((source) => (source ? [source.id] : [])),
    [trees.sources, workId, rootThreadId, chatId],
  );
  const workRows = useMemo<readonly ReferenceWork[]>(
    () =>
      (works ?? []).flatMap((work) => {
        const source = sourceFor(trees.sources, "scratch", { workId: work.id });
        return source && work.handle
          ? [{ sourceId: source.id, name: work.name, handle: work.handle }]
          : [];
      }),
    [works, trees.sources],
  );

  const latest = useRef({ trees, workNames, warmSources, workRows });
  const listeners = useRef(new Set<() => void>());
  // The open menu reads through the port, so a change to the trees is its cue to read again.
  useEffect(() => {
    latest.current = { trees, workNames, warmSources, workRows };
    for (const listener of [...listeners.current]) listener();
  }, [trees, workNames, warmSources, workRows]);

  return useMemo(() => {
    if (!projectId || projectPending) return null;
    const read = (sourceId: string): ReferenceSourceView | null => {
      const { trees: current, workNames: names } = latest.current;
      const source = current.sources.find((candidate) => candidate.id === sourceId);
      const tree = source ? current.tree(source.id) : null;
      if (!source || !tree) return null;
      const owner = source.owner;
      return {
        source: referenceSourceOf(source, {
          projectId,
          accountId,
          ownerLabel: owner.kind === "work" ? names.get(owner.workId) : undefined,
        }),
        tree,
      };
    };
    return {
      label,
      resolveReference: (reference) => {
        const { trees: current } = latest.current;
        if (reference.kind === "file") {
          const place = current.find(reference.id);
          const view = place ? read(place.source.id) : null;
          return place && view ? referenceRowForFile(place.file, view.source) : null;
        }
        for (const source of current.sources) {
          const entry = current.tree(source.id)?.entry(reference.id);
          const view = read(source.id);
          if (entry?.kind === "dir" && view) return referenceRowForFolder(entry, view.source);
        }
        return null;
      },
      openContext: () => ({
        warmSources: latest.current.warmSources,
        works: latest.current.workRows,
      }),
      port: {
        subscribe: (listener) => {
          listeners.current.add(listener);
          return () => listeners.current.delete(listener);
        },
        status: () =>
          latest.current.trees.isError
            ? "error"
            : latest.current.trees.isComplete
              ? "ready"
              : "loading",
        read,
      },
    };
  }, [accountId, label, projectId, projectPending]);
}
