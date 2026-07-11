/** Project-route composition for change-trail navigation. */
import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeFile,
  type ProjectContextTreeNode,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { getProjectContextTree, listProjectThreads } from "@/client/api/projects-api";
import type { TrailChange } from "@/client/change-trails";
import { useContextTabsActions } from "@/client/stores";
import { navigateToTrailChange } from "@/core/editor/change-trail-navigation";
import { contextTabFromFile } from "@/features/project/context/context-tab-from-file";

function findDocument(
  node: ProjectContextTreeNode,
  documentId: string,
): ProjectContextTreeFile | null {
  if (node.kind === "file") return node.documentId === documentId ? node : null;
  for (const child of node.children) {
    const match = findDocument(child, documentId);
    if (match) return match;
  }
  return null;
}

const NAVIGABLE_SCHEMES = ["manuscript", "kb", "user", "scratch"] as const;

export function useChangeTrailNavigation(threadId: string) {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const navigate = useNavigate();
  const { openTab } = useContextTabsActions();
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);

  return useCallback(
    (documentId: string, change: TrailChange) => {
      activeRequest.current?.abort();
      const request = new AbortController();
      activeRequest.current = request;
      return navigateToTrailChange({
        documentId,
        change,
        signal: request.signal,
        openDocument: async () => {
          if (!projectId) return false;
          const thread = (await listProjectThreads(projectId)).find((item) => item.id === threadId);
          if (request.signal.aborted) return false;
          const workId = thread?.workId ?? null;
          let resolved: { scheme: ProjectContextTreeScheme; file: ProjectContextTreeFile } | null =
            null;
          for (const scheme of NAVIGABLE_SCHEMES) {
            if (isWorkScopedProjectContextScheme(scheme) && !workId) continue;
            const { tree } = await getProjectContextTree(
              projectId,
              scheme,
              isWorkScopedProjectContextScheme(scheme)
                ? { workId: workId ?? undefined }
                : undefined,
            );
            const file = findDocument(tree, documentId);
            if (file) {
              resolved = { scheme, file };
              break;
            }
          }
          if (!resolved?.file.editable) return false;
          if (request.signal.aborted) return false;
          const { scheme, file } = resolved;
          openTab(projectId, contextTabFromFile(scheme, file, workId));
          await navigate({
            to: "/project/$projectId",
            params: { projectId },
            search: (previous) => ({
              ...previous,
              screen: "context" as const,
              scheme,
              path: file.path,
              results: undefined,
            }),
          });
          return !request.signal.aborted;
        },
      }).finally(() => {
        if (activeRequest.current === request) activeRequest.current = null;
      });
    },
    [navigate, openTab, projectId, threadId],
  );
}
