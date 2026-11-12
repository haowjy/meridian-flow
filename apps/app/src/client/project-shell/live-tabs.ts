import { PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { useCallback, useMemo } from "react";
import {
  useAccountId,
  useAccountResourceProjection,
} from "@/features/project/context/account-feature-context";
import { projectResourceDocument } from "@/features/project/context/open-document-from-file";
import { useIsDraftOnly } from "@/features/project/context/use-is-draft-only";
import type { OpenDocument } from "../stores";
import { type MainTab, useMainTabs } from "./main-tabs";

const PROJECT_SCOPED_SCHEMES: ReadonlySet<string> = new Set(PROJECT_SCOPED_CONTEXT_URI_SCHEMES);

/**
 * Main's document tabs as the replica sees them now, for every reader of the tabs (the strip, the
 * tab list, the side's document list). The record can name a document deleted while the window was
 * closed: once the replica holds the project's catalog, a Project's document it neither places nor
 * knows as removed is gone, and its tab is left out here while the record is left alone, so a
 * document the replica later shows live again has its tab back. Each kept tab carries the
 * document's current descriptor (a rename or move made anywhere); `project` does the same for a
 * document that has no tab.
 */
export function useLiveTabs(projectId: string): {
  tabs: readonly MainTab[];
  project: (document: OpenDocument) => OpenDocument;
} {
  const recorded = useMainTabs(useAccountId(), projectId).tabs;
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
  return { tabs, project };
}
