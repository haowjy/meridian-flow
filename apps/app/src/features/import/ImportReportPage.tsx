/**
 * The import report: the Editor's address `imports/<importId>`. Fills in live
 * while files arrive and holds failures, Retry, Continue import, Stop here and
 * everything worth a look. It is a page, not a toast, and it stays until dismissed.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { cn } from "@/lib/utils";
import { processed } from "./display-state";
import { useImports } from "./ImportProvider";
import { useImportRoute } from "./import-route";
import {
  FailedSection,
  NotImportedSection,
  RenamedSection,
  RootsBlock,
  SkippedSection,
  WorthALookSection,
} from "./ReportSections";
import { reportHeader, summarySentences } from "./report-copy";
import { buildReportModel, type EntryRow } from "./report-model";
import { StopImportDialog } from "./StopImportDialog";
import { catalogPathOfUri } from "./tree-projection";
import { useImport } from "./use-import";

export function ImportReportPage({
  importId,
  onOpenDocument,
}: {
  importId: string;
  /** Opens a document by its context URI in the Editor, replacing this page. */
  onOpenDocument: (uri: string) => void;
}) {
  const { coordinator, openContinue } = useImports();
  const route = useImportRoute();
  const { state, display, counts, store } = useImport(importId, "report");
  const [stopping, setStopping] = useState(false);
  const model = useMemo(() => buildReportModel(state), [state]);

  const local = state.local;
  const report = state.report;
  const holds = local?.held != null;
  const names = local?.roots.map((root) => root.name) ?? model.roots.map((root) => root.name);

  // Load failures stand in for the page.
  if (!report?.complete && !local) {
    if (state.load === "missing")
      return (
        <Centered>
          <p className="font-medium text-foreground">
            <Trans>This import isn't available anymore.</Trans>
          </p>
          <Button variant="outline" size="sm" onClick={() => route.closeReport()}>
            <Trans>Back to the Editor</Trans>
          </Button>
        </Centered>
      );
    if (state.load === "error")
      return (
        <Centered>
          <p className="font-medium text-foreground">
            <Trans>Couldn't load this import.</Trans>
          </p>
          <Button variant="outline" size="sm" onClick={() => store.retryLoad()}>
            <Trans>Retry</Trans>
          </Button>
        </Centered>
      );
    return (
      <Centered>
        <Loader2
          aria-hidden
          className="size-5 animate-spin text-ink-muted motion-reduce:animate-none"
        />
      </Centered>
    );
  }

  // Stop here before anything was sent: the import ended on this tab alone.
  const nothingImported = !report && local?.phase.kind === "idle" && local.rows.length === 0;
  const destination = destinationName(state);
  const exportRoot =
    model.roots.length === 1 && model.roots[0].id === null && model.areas.length > 1;
  const header = nothingImported
    ? { title: t`Nothing was imported.` }
    : reportHeader({
        display,
        counts,
        destination,
        exportName: exportRoot ? model.roots[0].name : null,
        names,
        total: local?.total ?? 0,
        code: local?.phase.kind === "not-started" ? local.phase.code : null,
        stopped: (counts?.notImported ?? 0) > 0,
      });
  const percent = counts && counts.total > 0 ? (processed(counts) / counts.total) * 100 : 0;
  const showBar =
    display === "preparing" || display === "importing" || display === "importing-elsewhere";
  const failedCount = counts?.failed ?? 0;
  const arrivingCount = (counts?.arriving ?? 0) + failedCount;
  const hasServerImport = report !== null && report !== undefined;

  const open = (row: EntryRow) => {
    if (row.entry.uri) onOpenDocument(row.entry.uri);
  };
  const openRoot = (rootId: number) => {
    const root = model.roots.find((candidate) => candidate.rootId === rootId);
    const path = catalogPathOfUri(root?.uri ?? null);
    const scheme = root?.uri?.slice(0, root.uri.indexOf("://"));
    if (!root || !path || !scheme) return;
    if (root.kind === "folder") coordinator.reveal({ scheme, path });
    else onOpenDocument(root.uri as string);
  };

  const continueButton = (
    <Button className="[@media(pointer:coarse)]:min-h-11" onClick={() => openContinue(importId)}>
      <Trans>Continue import</Trans>
    </Button>
  );
  const stopButton = (
    <Button
      variant="outline"
      className="[@media(pointer:coarse)]:min-h-11"
      onClick={() => setStopping(true)}
    >
      <Trans>Stop here</Trans>
    </Button>
  );
  const actions = (() => {
    switch (display) {
      case "preparing":
      case "importing":
      case "importing-elsewhere":
        return stopButton;
      case "paused":
        return (
          <>
            {continueButton}
            {stopButton}
          </>
        );
      case "needs-attention":
        return (
          <>
            {holds ? (
              <Button onClick={() => coordinator.retry(importId)}>
                <Trans>Retry all</Trans>
              </Button>
            ) : (
              continueButton
            )}
            {stopButton}
          </>
        );
      case "didnt-start":
        return (
          <>
            {holds ? (
              <Button onClick={() => coordinator.tryAgain(importId)}>
                <Trans>Try again</Trans>
              </Button>
            ) : (
              continueButton
            )}
            {hasServerImport ? stopButton : null}
          </>
        );
      case "couldnt-stop":
        return (
          <>
            <Button onClick={() => void coordinator.stop(importId)}>
              <Trans>Try stopping again</Trans>
            </Button>
            <Button
              variant="outline"
              onClick={() => (holds ? coordinator.resume(importId) : openContinue(importId))}
            >
              <Trans>Keep importing</Trans>
            </Button>
          </>
        );
      case "finished":
        return (
          <Button
            variant="outline"
            className="[@media(pointer:coarse)]:min-h-11"
            onClick={() => {
              void coordinator.dismiss(importId);
              route.closeReport();
            }}
          >
            <Trans>Dismiss</Trans>
          </Button>
        );
      default:
        return null;
    }
  })();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn(editorColumnChrome, "pt-16 pb-24")}>
        {state.refreshFailed ? (
          <InlineErrorRow
            message={t`Couldn't refresh. Try again.`}
            onRetry={() => store.retryLoad()}
          />
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-headline-section text-foreground">{header.title}</h1>
            {"body" in header && header.body ? (
              <p className="mt-2 max-w-prose text-sm text-ink-muted">{header.body}</p>
            ) : null}
            {"note" in header && header.note ? (
              <p className="mt-1 text-sm text-ink-muted">{header.note}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {nothingImported ? <NothingDismiss onDone={() => route.closeReport()} /> : actions}
          </div>
        </div>
        {showBar ? (
          <Progress
            label={header.title}
            value={percent}
            indeterminate={display === "preparing"}
            className="mt-4 h-1.5"
          />
        ) : null}
        {nothingImported || !report ? null : (
          <>
            <RootsBlock
              roots={model.roots.map((root) => ({
                rootId: root.rootId,
                kind: root.kind,
                name: root.name,
                openable: root.uri !== null && display !== "preparing",
              }))}
              areasMessage={
                exportRoot ? (
                  <Trans>
                    Manuscript, Knowledge Base and Unfiled went back to their own areas.
                  </Trans>
                ) : undefined
              }
              onOpenRoot={openRoot}
              summary={counts ? summarySentences(counts) : []}
            />
            <FailedSection
              rows={model.failed}
              canRetry={holds}
              onRetry={(entryId) => coordinator.retry(importId, [entryId])}
              onRetryAll={() => coordinator.retry(importId)}
              onOpen={open}
            />
            <WorthALookSection model={model} onOpen={open} />
            <RenamedSection rows={model.renamed} onOpen={open} />
            <SkippedSection model={model} />
            <NotImportedSection model={model} onOpen={open} />
          </>
        )}
      </div>
      {stopping ? (
        <StopImportDialog
          remaining={arrivingCount}
          onKeep={() => setStopping(false)}
          onStop={() => {
            setStopping(false);
            void coordinator.stop(importId);
          }}
        />
      ) : null}
    </div>
  );
}

function NothingDismiss({ onDone }: { onDone: () => void }) {
  return (
    <Button variant="outline" onClick={onDone}>
      <Trans>Dismiss</Trans>
    </Button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
      <div className="flex flex-col items-center gap-3">{children}</div>
    </div>
  );
}

/** The folder or area the import went into, for the header. */
function destinationName(state: ReturnType<typeof useImport>["state"]): string {
  if (state.local) return state.local.destination.name;
  const uri = state.report?.summary.destination.folderUri ?? "";
  const path = catalogPathOfUri(uri);
  if (path && path !== "/") return path.slice(path.lastIndexOf("/") + 1);
  return areaName(uri);
}

function areaName(uri: string): string {
  if (uri.startsWith("manuscript://")) return t`Manuscript`;
  if (uri.startsWith("unfiled://")) return t`Unfiled`;
  return t`Knowledge Base`;
}
