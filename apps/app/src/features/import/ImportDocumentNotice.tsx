/**
 * The notice above a document that is an import's file: still arriving, paused,
 * didn't import, or written in before its text arrived. The arriving state needs
 * only the catalog's flag, so it shows after a reload and through a link; the
 * rest need the import's own entry for this document.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FolderInput, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { type ContextTab, tabContextOwner } from "@/client/stores";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import { Button } from "@/components/ui/button";
import { useImports, useImportsSnapshot, useOptionalImports } from "./ImportProvider";
import { useImportRoute } from "./import-route";
import { effectiveEntry } from "./import-state";
import { displayOf } from "./import-store";
import { failureSentence } from "./reason-copy";

function useImportPending(projectId: string, tab: ContextTab): boolean {
  const owner = tab.kind === "new" ? {} : tabContextOwner(tab);
  const { catalog } = useContextCatalogView(
    projectId,
    tab.kind === "new" ? "unfiled" : tab.scheme,
    {
      ...owner,
      enabled: tab.kind !== "new",
    },
  );
  return tab.kind !== "new" && catalog?.findDocument(tab.documentId)?.importPending === true;
}

export function ImportDocumentNotice(props: {
  projectId: string;
  tab: ContextTab;
  className?: string;
}) {
  // Rendered outside a project (tests, previews), there is no import to speak of.
  return useOptionalImports() ? <Notice {...props} /> : null;
}

function Notice({
  projectId,
  tab,
  className,
}: {
  projectId: string;
  tab: ContextTab;
  className?: string;
}) {
  const pending = useImportPending(projectId, tab);
  const { coordinator, openContinue } = useImports();
  const route = useImportRoute();
  const snapshot = useImportsSnapshot(coordinator);

  // The document's own entry, from whichever loaded import holds it.
  const found = useMemo(() => {
    for (const state of snapshot.states) {
      for (const entry of state.report?.entries.values() ?? []) {
        if (entry.documentId === tab.documentId)
          return { state, entry: effectiveEntry(state, entry) };
      }
    }
    return null;
  }, [snapshot, tab.documentId]);

  // Until an import has it, keep the open imports loading so the notice can say more.
  useEffect(() => {
    if (found || !pending) return;
    const stops = snapshot.states
      .filter((state) => state.report?.summary.state !== "finished")
      .map((state) => coordinator.store(state.importId).watch("notice"));
    return () => {
      for (const stop of stops) stop();
    };
  }, [found, pending, snapshot, coordinator]);

  if (!found) {
    return pending ? (
      <DocumentNotice
        className={className}
        icon={<Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
      >
        <Trans>This file is still importing. Its text will appear here.</Trans>
      </DocumentNotice>
    ) : null;
  }

  const { state, entry } = found;
  const importId = state.importId;
  const holds = state.local?.held != null;
  const view = (
    <Button
      size="sm"
      variant="outline"
      className="[@media(pointer:coarse)]:min-h-11"
      onClick={() => route.openReport(importId)}
    >
      <Trans>View import</Trans>
    </Button>
  );

  if (entry.state === "failed") {
    const wroteHere = entry.reason === "edited_before_arrival";
    const retry = (
      <Button
        size="sm"
        variant="outline"
        className="[@media(pointer:coarse)]:min-h-11"
        onClick={() =>
          holds ? coordinator.retry(importId, [entry.entryId]) : openContinue(importId)
        }
      >
        {wroteHere ? <Trans>Add imported text at the top</Trans> : <Trans>Retry</Trans>}
      </Button>
    );
    return (
      <DocumentNotice
        className={className}
        icon={
          <TriangleAlert
            aria-hidden
            className={wroteHere ? "size-4 text-status-warning" : "size-4 text-destructive"}
          />
        }
        action={holds ? retry : view}
      >
        {wroteHere
          ? t`You wrote here before the imported text arrived.`
          : t`This file didn't import. ${failureSentence(entry.reason)}`}
      </DocumentNotice>
    );
  }

  if (entry.state === "planned" || entry.state === "landing") {
    const paused = displayOf(state) === "paused";
    return (
      <DocumentNotice
        className={className}
        icon={
          paused ? (
            <FolderInput aria-hidden className="size-4 text-status-warning" />
          ) : (
            <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          )
        }
        action={view}
      >
        {paused
          ? t`This file's import is paused.`
          : t`This file is still importing. Its text will appear here.`}
      </DocumentNotice>
    );
  }
  return null;
}
