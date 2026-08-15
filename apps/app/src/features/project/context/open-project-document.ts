/**
 * Opening a project document by id — the app's one answer to "take me there".
 *
 * A document id is all a door carries: a change trail's receipt, a search
 * result, a wikilink the writer just followed. Turning that id into an open
 * tab means finding which scheme's tree holds it, and that lookup plus the
 * openTab-and-route pair is the same work every door was about to write for
 * itself.
 *
 * Two dispositions, because a writer who asked for a new tab did not ask to
 * leave the sentence they are in: `current` moves the pane to the document,
 * and `background` opens it on the tab strip and stays put. There is no
 * browser-tab disposition — the manuscript is a live collaborative session,
 * and a second window on it costs the writer their place to reach a document
 * that was already one tab away.
 */

import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeFile,
  type ProjectContextTreeNode,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { getProjectContextTree } from "@/client/api/projects-api";
import { useContextTabsActions } from "@/client/stores";

import { contextTabFromFile } from "./context-tab-from-file";

/** Where a document may live. Work-scoped schemes need the work to look in. */
const NAVIGABLE_SCHEMES = ["manuscript", "kb", "user", "scratch"] as const;

export type OpenProjectDocumentRequest = {
  documentId: string;
  /** The work whose scratch to search; without one, work-scoped schemes are skipped. */
  workId?: string | null;
  disposition?: "current" | "background";
  /** Abandons the open when the caller that asked for it is gone. */
  signal?: AbortSignal;
};

/** False when the document was not found, is not editable, or the caller left. */
export type OpenProjectDocument = (request: OpenProjectDocumentRequest) => Promise<boolean>;

export function useOpenProjectDocument(projectId: string | undefined): OpenProjectDocument {
  const navigate = useNavigate();
  const { openTab } = useContextTabsActions();

  return useCallback(
    async ({ documentId, workId = null, disposition = "current", signal }) => {
      if (!projectId) return false;
      const found = await findDocument(projectId, documentId, workId, signal);
      if (!found || signal?.aborted) return false;
      // A viewer-only file has no editing surface to land in, and a tab that
      // opened on one would be a door into nothing.
      if (!found.file.editable) return false;

      const { scheme, file } = found;
      openTab(projectId, contextTabFromFile(scheme, file, workId));
      if (disposition === "background") return true;

      await navigate({
        to: "/project/$projectId",
        params: { projectId },
        search: (previous) => ({
          ...previous,
          screen: "context" as const,
          scheme,
          work: workId ?? undefined,
          path: file.path,
          results: undefined,
        }),
      });
      return !signal?.aborted;
    },
    [navigate, openTab, projectId],
  );
}

async function findDocument(
  projectId: string,
  documentId: string,
  workId: string | null,
  signal: AbortSignal | undefined,
): Promise<{ scheme: ProjectContextTreeScheme; file: ProjectContextTreeFile } | null> {
  for (const scheme of NAVIGABLE_SCHEMES) {
    if (isWorkScopedProjectContextScheme(scheme) && !workId) continue;
    const { tree } = await getProjectContextTree(
      projectId,
      scheme,
      isWorkScopedProjectContextScheme(scheme) ? { workId: workId ?? undefined } : undefined,
    );
    if (signal?.aborted) return null;
    const file = fileWithin(tree, documentId);
    if (file) return { scheme, file };
  }
  return null;
}

function fileWithin(
  node: ProjectContextTreeNode,
  documentId: string,
): ProjectContextTreeFile | null {
  if (node.kind === "file") return node.documentId === documentId ? node : null;
  for (const child of node.children) {
    const match = fileWithin(child, documentId);
    if (match) return match;
  }
  return null;
}
