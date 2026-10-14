/**
 * The mark an import's own run puts on a tree row: a spinner on the destination while
 * its selection is read, and after a refused or lost plan a warning on the root row
 * whose menu offers Try again and Discard.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Loader2, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import type { ImportRowInfo } from "@/client/query/context-catalog-projection";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { refusalSentence } from "@/features/import/reason-copy";
import { useImportRowActions } from "@/features/import/use-import-row-actions";

export function ImportRunMark({ info }: { info: ImportRowInfo | undefined }) {
  const actions = useImportRowActions(info);
  if (info?.reading)
    return (
      <span
        role="img"
        aria-label={t`Reading your files`}
        title={t`Reading your files`}
        className="flex size-7 shrink-0 items-center justify-center text-ink-muted"
      >
        <Loader2 aria-hidden className="size-3.5 animate-spin" />
      </span>
    );
  if (!info?.notStarted) return null;
  const message = t`Import didn't start. ${refusalSentence(info.notStarted.code)}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={message}
          title={message}
          onClick={(event) => event.stopPropagation()}
          className="focus-ring flex size-7 shrink-0 items-center justify-center rounded-md text-destructive"
        >
          <TriangleAlert aria-hidden className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={() => actions?.tryAgain?.()}>
          <RotateCcw className="size-3.5 text-muted-foreground" aria-hidden />
          <Trans>Try again</Trans>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions?.discard?.()}>
          <Trash2 className="size-3.5 text-muted-foreground" aria-hidden />
          <Trans>Discard</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
