import { PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { ownerOfSource, type ProjectTrees, useProjectTrees } from "@/client/query/useProjectTrees";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { serverDocumentFromFile } from "@/features/project/context/open-document-from-file";
import { useIsDraftOnly } from "@/features/project/context/use-is-draft-only";
import type { OpenDocument } from "../stores";
import { type Lane, type MainTabs, mainTabKey, useMainTabs } from "./main-tabs";

const PROJECT_SCOPED_SCHEMES: ReadonlySet<string> = new Set(PROJECT_SCOPED_CONTEXT_URI_SCHEMES);

/**
 * Main's tabs, both lanes, as the project sees them now, for every reader of the tabs (the strip,
 * the tab list, the side's document list, the tab commands). The chat lane is the record: a chat
 * deleted elsewhere is dropped from it by `useDropGoneChatTabs`. The record can name a document deleted while the window
 * was closed: once the project's list has synced, a Project's document it does not show is gone,
 * and its tab is left out here while the record is left alone, so a document the list later shows
 * live again has its tab back. Each kept tab carries the document's current descriptor (a rename
 * or move made anywhere); `project` does the same for a document that has no tab.
 */
export type LiveTabs = {
  lanes: MainTabs;
  project: (document: OpenDocument) => OpenDocument;
};

const LiveTabsContext = createContext<LiveTabs | null>(null);

/** The one projection every reader of the tabs shares: it re-projects once per change, not per reader. */
export function LiveTabsProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  return (
    <LiveTabsContext.Provider value={useProjectLiveTabs(projectId)}>
      {children}
    </LiveTabsContext.Provider>
  );
}

export function useLiveTabs(): LiveTabs {
  const live = useContext(LiveTabsContext);
  if (!live) throw new Error("useLiveTabs needs the project's LiveTabsProvider");
  return live;
}

/** The tab for a document as the project's list shows it now; null while the list does not hold it. */
function currentTab(trees: ProjectTrees, tab: OpenDocument): OpenDocument | null {
  const place = trees.find(tab.documentId);
  if (!place) return null;
  return serverDocumentFromFile(place.source.scheme, place.file, ownerOfSource(place.source));
}

function useProjectLiveTabs(projectId: string): LiveTabs {
  const lanes = useMainTabs(useAccountId(), projectId);
  const recorded = lanes.document.tabs;
  const trees = useProjectTrees(projectId);
  const isDraftOnly = useIsDraftOnly(projectId);
  const project = useCallback(
    (document: OpenDocument) =>
      (isDraftOnly(document.documentId) ? null : currentTab(trees, document)) ?? document,
    [trees, isDraftOnly],
  );
  const tabs = useMemo(
    () =>
      recorded.flatMap((tab): Lane<"document">["tabs"][number][] => {
        const { document } = tab;
        // A draft-only document is one live doesn't hold, so the list says nothing about it: its
        // draft settlement owns it.
        if (
          document.kind === "new" ||
          !PROJECT_SCOPED_SCHEMES.has(document.scheme) ||
          isDraftOnly(document.documentId)
        )
          return [tab];
        const current = currentTab(trees, document);
        if (current) return [{ kind: "document", document: current }];
        // Not in the list: gone once the list has synced, not before.
        return trees.isComplete ? [] : [tab];
      }),
    [recorded, trees, isDraftOnly],
  );
  const selected = lanes.document.selected;
  const live = useMemo<Lane<"document">>(
    () => ({
      tabs,
      selected: tabs.some((tab) => mainTabKey(tab) === selected) ? selected : null,
    }),
    [tabs, selected],
  );
  const chat = lanes.chat;
  return useMemo(() => ({ lanes: { document: live, chat }, project }), [live, chat, project]);
}
