/**
 * The notice above a document that is an import's file: still arriving, stopped
 * partway, didn't import, or written in before its text arrived. The arriving state needs
 * only the catalog's flag, so it shows after a reload and through a link; the
 * rest need the import's own entry for this document, which the coordinator's
 * document index finds.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ImportIcon, Loader2, TriangleAlert } from "lucide-react";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { type ContextTab, tabContextOwner } from "@/client/stores";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import { Button } from "@/components/ui/button";
import { useImports, useImportsSnapshot, useOptionalImports } from "./ImportProvider";
import { effectiveEntry } from "./import-state";
import { failureSentence } from "./reason-copy";
import { useImport } from "./use-import";

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
  const { coordinator } = useImports();
  // The coordinator indexes every open import's documents, so no scan and no watching here.
  const entry = useImportsSnapshot(coordinator).documents.get(
    tab.kind === "new" ? "" : tab.documentId,
  );
  if (entry) return <EntryNotice {...entry} className={className} />;
  return pending ? <ArrivingNotice className={className} /> : null;
}

function ArrivingNotice({ className }: { className?: string }) {
  return (
    <DocumentNotice
      className={className}
      icon={<Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
    >
      <Trans>This file is still importing. Its text will appear here.</Trans>
    </DocumentNotice>
  );
}

/** The notice for a document whose import is known. */
function EntryNotice({
  importId,
  entryId,
  className,
}: {
  importId: string;
  entryId: number;
  className?: string;
}) {
  const { coordinator, openContinue } = useImports();
  const view = useImport(importId);
  const raw = view?.state.status?.entries.get(entryId);
  if (!view || !raw) return null;
  const { state, display } = view;
  const entry = effectiveEntry(state, raw);
  const holds = state.local?.held != null;

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
        {!holds ? (
          <Trans>Continue import</Trans>
        ) : wroteHere ? (
          <Trans>Add imported text at the top</Trans>
        ) : (
          <Trans>Retry</Trans>
        )}
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
        action={retry}
      >
        {wroteHere
          ? t`You wrote here before the imported text arrived.`
          : t`This file didn't import. ${failureSentence(entry.reason)}`}
      </DocumentNotice>
    );
  }

  if (entry.state !== "planned" && entry.state !== "landing") return null;
  if (display !== "paused") return <ArrivingNotice className={className} />;
  return (
    <DocumentNotice
      className={className}
      icon={<ImportIcon aria-hidden className="size-4 text-status-warning" />}
      action={
        <Button
          size="sm"
          variant="outline"
          className="[@media(pointer:coarse)]:min-h-11"
          onClick={() => (holds ? coordinator.resume(importId) : openContinue(importId))}
        >
          <Trans>Continue import</Trans>
        </Button>
      }
    >
      {t`This file's import stopped partway.`}
    </DocumentNotice>
  );
}
