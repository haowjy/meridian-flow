import { PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { ownerOfSource, type ProjectTrees, useProjectTrees } from "@/client/query/useProjectTrees";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { serverDocumentFromFile } from "@/features/project/context/open-document-from-file";
import type { OpenDocument } from "../stores";
import { type Lane, type MainTabs, mainTabKey, useMainTabs } from "./main-tabs";

const PROJECT_SCOPED_SCHEMES: ReadonlySet<string> = new Set(PROJECT_SCOPED_CONTEXT_URI_SCHEMES);

export type LiveTabs = {
  lanes: MainTabs;
  project: (document: OpenDocument) => OpenDocument;
};

const LiveTabsContext = createContext<LiveTabs | null>(null);

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

function currentTab(trees: ProjectTrees, tab: OpenDocument): OpenDocument | null {
  const place = trees.find(tab.documentId);
  if (!place) return null;
  return serverDocumentFromFile(place.source.scheme, place.file, ownerOfSource(place.source));
}

function useProjectLiveTabs(projectId: string): LiveTabs {
  const lanes = useMainTabs(useAccountId(), projectId);
  const recorded = lanes.document.tabs;
  const trees = useProjectTrees(projectId);
  const project = useCallback(
    (document: OpenDocument) => currentTab(trees, document) ?? document,
    [trees],
  );
  const tabs = useMemo(
    () =>
      recorded.flatMap((tab): Lane<"document">["tabs"][number][] => {
        const { document } = tab;
        if (document.kind === "new" || !PROJECT_SCOPED_SCHEMES.has(document.scheme)) return [tab];
        const current = currentTab(trees, document);
        if (current) return [{ kind: "document", document: current }];
        return trees.isComplete ? [] : [tab];
      }),
    [recorded, trees],
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
