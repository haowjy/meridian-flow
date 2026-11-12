import { PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { useCallback, useMemo } from "react";
import {
  useAccountId,
  useAccountResourceProjection,
} from "@/features/project/context/account-feature-context";
import { projectResourceDocument } from "@/features/project/context/open-document-from-file";
import { useIsDraftOnly } from "@/features/project/context/use-is-draft-only";
import { useProjectThreads } from "../query/useProjectThreads";
import type { OpenDocument } from "../stores";
import { type MainTab, type MainTabKind, useMainTabs } from "./main-tabs";

const PROJECT_SCOPED_SCHEMES: ReadonlySet<string> = new Set(PROJECT_SCOPED_CONTEXT_URI_SCHEMES);

/**
 * Main's tabs, both lanes, as the project sees them now, for every reader of the tabs (the strip,
 * the tab list, the side's document list). The record can name a chat the server no longer lists
 * (deleted elsewhere or while the window was closed): once the project's chat list has loaded, such
 * a tab is left out, with the record left alone. It can name a document deleted while the window
 * was closed: once the replica holds the project's catalog, a Project's document it neither places nor
 * knows as removed is gone, and its tab is left out here while the record is left alone, so a
 * document the replica later shows live again has its tab back. Each kept tab carries the
 * document's current descriptor (a rename or move made anywhere); `project` does the same for a
 * document that has no tab.
 */
export function useLiveTabs(projectId: string): {
  tabs: Readonly<Record<MainTabKind, readonly MainTab[]>>;
  project: (document: OpenDocument) => OpenDocument;
} {
  const lanes = useMainTabs(useAccountId(), projectId);
  const recorded = lanes.document.tabs;
  const { threads } = useProjectThreads(projectId);
  const { records, placement } = useAccountResourceProjection(projectId);
  const isDraftOnly = useIsDraftOnly(projectId);
  const project = useCallback(
    (document: OpenDocument) => {
      const projected = projectResourceDocument(
        document,
        records,
        placement,
        isDraftOnly(document.documentId),
      );
      return projected.kind === "projected" ? projected.document : document;
    },
    [records, placement, isDraftOnly],
  );
  const tabs = useMemo(
    () =>
      recorded.flatMap((tab): MainTab[] => {
        if (tab.kind !== "document") return [];
        const { document } = tab;
        const projected = projectResourceDocument(
          document,
          records,
          placement,
          isDraftOnly(document.documentId),
        );
        if (projected.kind === "projected")
          return [{ kind: "document", document: projected.document }];
        if (projected.kind === "terminal" || projected.kind === "removed") return [];
        const keep =
          records.length === 0 ||
          document.kind === "new" ||
          !PROJECT_SCOPED_SCHEMES.has(document.scheme) ||
          isDraftOnly(document.documentId);
        return keep ? [tab] : [];
      }),
    [recorded, records, placement, isDraftOnly],
  );
  const chats = useMemo(() => {
    if (!threads) return lanes.chat.tabs;
    const listed = new Set(
      threads.filter((thread) => !thread.deletedAt).map((thread) => thread.id),
    );
    return lanes.chat.tabs.filter((tab) => tab.kind === "chat" && listed.has(tab.chatId));
  }, [lanes.chat.tabs, threads]);
  return { tabs: { document: tabs, chat: chats }, project };
}
