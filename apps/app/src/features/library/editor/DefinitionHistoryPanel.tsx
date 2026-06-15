/**
 * DefinitionHistoryPanel — quiet revision list with restore-as-new-revision actions.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { DefinitionRevisionSummary } from "@meridian/contracts/agents";
import { History } from "lucide-react";
import { useMemo } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { relativeTime } from "@/features/project/relative-time";
import { cn } from "@/lib/utils";

export function DefinitionHistoryPanel({
  revisions,
  status,
  disabled,
  restoringRevisionId,
  onOpenChange,
  onRestore,
}: {
  revisions: DefinitionRevisionSummary[] | null;
  status: "loading" | "ready" | "error";
  disabled?: boolean;
  restoringRevisionId: string | null;
  onOpenChange?: (open: boolean) => void;
  onRestore: (revisionId: string) => void;
}) {
  const nowMs = useMemo(() => Date.now(), []);

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "focus-ring inline-flex items-center gap-1 rounded-md px-2 py-1 text-meta font-medium text-muted-foreground hover:bg-surface-subtle hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <History className="size-3.5" aria-hidden />
          <Trans>History</Trans>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border-subtle px-3 py-2">
          <p className="text-sm font-medium text-foreground">
            <Trans>Revision history</Trans>
          </p>
          <p className="text-meta text-muted-foreground">
            <Trans>Restoring creates a new revision. History is kept.</Trans>
          </p>
        </div>
        <div className="max-h-64 overflow-y-auto overscroll-y-contain p-2">
          {status === "loading" ? (
            <p className="px-2 py-3 text-meta text-muted-foreground">
              <Trans>Loading history…</Trans>
            </p>
          ) : null}
          {status === "error" ? (
            <p className="px-2 py-3 text-meta text-destructive">
              <Trans>Could not load history.</Trans>
            </p>
          ) : null}
          {status === "ready" && revisions?.length === 0 ? (
            <p className="px-2 py-3 text-meta text-muted-foreground">
              <Trans>No revisions yet.</Trans>
            </p>
          ) : null}
          {status === "ready" && revisions && revisions.length > 0
            ? revisions.map((revision) => (
                <div
                  key={revision.id}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-2 hover:bg-surface-subtle"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-foreground">
                      {formatRevisionTimestamp(revision.createdAt)}
                    </p>
                    <p className="text-meta text-muted-foreground">
                      {relativeTime(revision.createdAt, nowMs)}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={restoringRevisionId === revision.id}
                    onClick={() => onRestore(revision.id)}
                    className="focus-ring shrink-0 rounded-md px-2 py-1 text-meta font-medium text-foreground hover:bg-card disabled:opacity-50"
                  >
                    {restoringRevisionId === revision.id ? (
                      <Trans>Restoring…</Trans>
                    ) : (
                      <Trans>Restore</Trans>
                    )}
                  </button>
                </div>
              ))
            : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function formatRevisionTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function restoreOriginalLabel(): string {
  return t`Restore original`;
}
