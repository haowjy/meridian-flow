/**
 * The import status row: the destination folder's first child while an import is
 * open. One or two lines and a thin bar; Enter opens the report. Dismiss is a
 * sibling button, never inside the open button.
 */
import { t } from "@lingui/core/macro";
import { FolderInput, Loader2, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Progress } from "@/components/ui/progress";
import { contextTreeRowGrowClassName } from "@/features/project/context/context-row-geometry";
import { cn } from "@/lib/utils";
import { processed } from "./display-state";
import { useImports } from "./ImportProvider";
import { useImportRoute } from "./import-route";
import { buildReportModel } from "./report-model";
import { statusLines } from "./status-copy";
import { useImport } from "./use-import";

const FAILURE_STATES = ["needs-attention", "didnt-start", "couldnt-stop"] as const;

/** Whether a surface may offer to dismiss: only a finished import. */
function dismissible(display: string) {
  return display === "finished";
}

export function ImportStatusRow({
  importId,
  paddingLeft,
  variant = "tree",
}: {
  importId: string;
  /** Left padding in px, matching the rows beside it. */
  paddingLeft: number;
  /** `phone` runs edge to edge like the Files browser's rows. */
  variant?: "tree" | "phone";
}) {
  const { coordinator } = useImports();
  const route = useImportRoute();
  const { state, display, counts, store } = useImport(importId, "row");
  const element = useRef<HTMLDivElement>(null);
  // A finished import's "worth a look" count comes from the whole report (the server's
  // count includes renames), so read it once for a row that shows one.
  const needsReport =
    display === "finished" && (counts?.findings ?? 0) > 0 && !state.report?.complete;
  useEffect(() => {
    if (needsReport) void store.refresh(true);
  }, [needsReport, store]);
  // The importing tab's own row scrolls into view once, when it appears.
  const startedHere = state.local !== null;
  useEffect(() => {
    if (startedHere) element.current?.scrollIntoView({ block: "nearest" });
  }, [startedHere]);
  const hashedBytes = useSyncExternalStore(store.subscribeHashed, store.getHashed, store.getHashed);
  if (state.dismissing && !state.dismissFailed) return null;

  const local = state.local;
  const phase = local?.phase;
  const hashedPercent =
    phase?.kind === "preparing" && !phase.planning && phase.totalBytes > 0
      ? (hashedBytes / phase.totalBytes) * 100
      : phase?.kind === "preparing" && phase.totalBytes === 0 && !phase.planning
        ? 100
        : null;
  const lines = statusLines({
    display,
    counts,
    preparingTotal: local?.total ?? 0,
    hashedPercent,
    stopped: false,
    // Until the report is read, say nothing rather than a count the report would contradict.
    worthALook: state.report?.complete ? buildReportModel(state).worthALookCount : 0,
  });
  const failed = (FAILURE_STATES as readonly string[]).includes(display);
  const line2 = state.dismissFailed ? t`Couldn't dismiss. Try again.` : lines.line2;
  const percent = counts && counts.total > 0 ? (processed(counts) / counts.total) * 100 : 0;
  const active = display === "preparing" || display === "stopping";

  return (
    <div
      ref={element}
      role="status"
      className={cn(
        "group flex items-center text-sm text-foreground",
        variant === "tree"
          ? "mx-2 rounded-md pr-1 hover:bg-sidebar-accent/50"
          : "min-h-11 w-full pr-2 active:bg-sidebar-accent",
        contextTreeRowGrowClassName,
      )}
      style={{ paddingLeft }}
    >
      <button
        type="button"
        onClick={() => route.openReport(importId)}
        className="focus-ring flex min-w-0 flex-1 items-center rounded-md py-1 text-left"
      >
        <span className="flex h-7 w-4 shrink-0" aria-hidden />
        <span className="flex h-7 w-4 shrink-0 items-center justify-center">
          {failed ? (
            <TriangleAlert aria-hidden className="size-3.5 text-destructive" />
          ) : active ? (
            <Loader2
              aria-hidden
              className="size-3.5 animate-spin text-ink-muted motion-reduce:animate-none"
            />
          ) : (
            <FolderInput
              aria-hidden
              className={cn(
                "size-3.5",
                display === "paused" ? "text-status-warning" : "text-ink-muted",
              )}
            />
          )}
        </span>
        <span className="ml-0.5 flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <span className="truncate">{lines.line1}</span>
          {line2 ? (
            <span
              className={cn(
                "text-caption break-words",
                state.dismissFailed ? "text-destructive" : "text-ink-muted",
              )}
            >
              {line2}
            </span>
          ) : null}
          {lines.bar !== "none" ? (
            <Progress
              label={lines.line1}
              value={
                lines.bar === "determinate"
                  ? display === "preparing"
                    ? (hashedPercent ?? 0)
                    : percent
                  : 0
              }
              indeterminate={lines.bar === "indeterminate"}
              className="mt-0.5 h-0.5"
              fillClassName={lines.bar === "static" ? "w-full bg-ink-subtle" : undefined}
            />
          ) : null}
        </span>
      </button>
      {dismissible(display) || state.dismissFailed ? (
        <button
          type="button"
          aria-label={t`Dismiss`}
          title={t`Dismiss`}
          onClick={() => void coordinator.dismiss(importId)}
          className="focus-ring flex size-6 shrink-0 items-center justify-center rounded-md text-ink-muted opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:size-11 [@media(hover:none)]:opacity-100"
        >
          <X aria-hidden className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
