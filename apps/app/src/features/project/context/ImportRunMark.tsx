/**
 * The mark an import's own run puts on its operation target (a root row, the
 * destination or an area header, wherever `targetOf` resolves), on the tree and the
 * phone listing alike. Every state has one: a spinner while the selection is read or
 * the files are sent, a warning when the import didn't start, paused or has failed
 * files. Each menu opens with the state's sentence and offers the commands that state
 * allows, Stop included. The future progress popup reads the same `ImportRowInfo`.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Loader2, Play, RotateCcw, Square, Trash2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { ImportRowInfo } from "@/client/query/context-catalog-projection";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { refusalSentence, runSentence } from "@/features/import/reason-copy";
import { useImportRowActions } from "@/features/import/use-import-row-actions";

const MARK_BOX =
  "flex size-7 shrink-0 items-center justify-center [@media(pointer:coarse)]:size-11";

export function ImportRunMark({ info }: { info: ImportRowInfo | undefined }) {
  const actions = useImportRowActions(info);
  if (info?.reading) return <SpinnerMark label={t`Reading your files`} />;
  const run = info?.run;
  if (run?.kind === "stopping") return <SpinnerMark label={runSentence(run)} />;
  if (run) {
    const message = runSentence(run);
    const warn = run.kind !== "sending";
    return (
      <MarkMenu message={message} warn={warn}>
        {run.kind === "failed" && run.canRetry ? (
          <MenuAction onSelect={actions?.retryFailed}>
            <RotateCcw className="size-3.5 text-muted-foreground" aria-hidden />
            <Trans>Retry failed files</Trans>
          </MenuAction>
        ) : null}
        {run.kind === "interrupted" || (run.kind === "failed" && !run.canRetry) ? (
          <MenuAction onSelect={actions?.continueImport}>
            <Play className="size-3.5 text-muted-foreground" aria-hidden />
            <Trans>Continue import…</Trans>
          </MenuAction>
        ) : null}
        <MenuAction onSelect={actions?.stop}>
          <Square className="size-3.5 text-muted-foreground" aria-hidden />
          {run.kind === "sending" ? <Trans>Stop import</Trans> : <Trans>Stop here</Trans>}
        </MenuAction>
      </MarkMenu>
    );
  }
  if (!info?.notStarted) return null;
  return (
    <MarkMenu message={t`Import didn't start. ${refusalSentence(info.notStarted.code)}`} warn>
      <MenuAction onSelect={actions?.tryAgain}>
        <RotateCcw className="size-3.5 text-muted-foreground" aria-hidden />
        <Trans>Try again</Trans>
      </MenuAction>
      <MenuAction onSelect={actions?.discard}>
        <Trash2 className="size-3.5 text-muted-foreground" aria-hidden />
        <Trans>Discard</Trans>
      </MenuAction>
    </MarkMenu>
  );
}

function SpinnerMark({ label }: { label: string }) {
  return (
    <span role="img" aria-label={label} title={label} className={`${MARK_BOX} text-ink-muted`}>
      <Loader2 aria-hidden className="size-3.5 animate-spin" />
    </span>
  );
}

function MenuAction({ onSelect, children }: { onSelect?: () => void; children: ReactNode }) {
  return <DropdownMenuItem onSelect={() => onSelect?.()}>{children}</DropdownMenuItem>;
}

/** A quiet spinner (sending) or a warning, opening a menu whose first line is the sentence. */
function MarkMenu({
  message,
  warn,
  children,
}: {
  message: string;
  warn: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={message}
          title={message}
          onClick={(event) => event.stopPropagation()}
          className={`focus-ring ${MARK_BOX} rounded-md ${warn ? "text-destructive" : "text-ink-muted"}`}
        >
          {warn ? (
            <TriangleAlert aria-hidden className="size-3.5" />
          ) : (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuLabel className="max-w-64 whitespace-normal font-normal text-ink-muted">
          {message}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
