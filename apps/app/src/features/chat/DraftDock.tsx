/**
 * DraftDock — the composer-attached strip for a Work's pending AI changes.
 *
 * Visual model: a jade-tinted strip that sits BEHIND the composer (narrower
 * via horizontal margin, top corners rounded) — the composer keeps its own
 * border and overlaps the strip's top edge, creating a layered look. The strip
 * mounts only when pending drafts exist; no terminal flash, no generating
 * state — the streaming turn in the transcript is sufficient.
 *
 * Single doc: name inline, clicking the strip opens review directly.
 * Multi doc: "N documents" with chevron, clicking toggles expand/collapse.
 *
 * Verb order follows the one draft-action grammar: the action that commits is
 * rightmost, Discard sits immediately left of it, and anything backing out
 * (Keep, Cancel) is leftmost.
 *
 * All visibility derives from `DraftReviewProvider` state (never raw queries),
 * so the dock, the editor bar, and the transcript can never disagree about what
 * is pending.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { usePostApplySnapshot } from "@/features/project/draft-apply-recovery/DraftApplyRecoveryProvider";
import { projectDraftDispositionRows } from "@/features/project/draft-apply-recovery/draft-apply-recovery-owner";
import { useProjectDraftApplyRecovery } from "@/features/project/draft-apply-recovery/ProjectDraftApplyRecoveryExecutor";
import { contextUriFromWritePath } from "@/lib/context-uri";
import { cn } from "@/lib/utils";
import { useChatContextNavigation } from "./ChatContextNavigation";
import { useDraftReview } from "./DraftReviewProvider";
import { type DockRow, dockRows } from "./docked-drafts";
import { draftCommandErrorKey, useDraftCommandErrors } from "./draft-command-errors";
import type { InlineReviewMessageCode } from "./draft-review-session";
import { aggregateDraftStats, DraftStatsLabel, draftStats } from "./draft-stats";
import { ReviewMessageText } from "./ReviewMessageText";

export type DraftDockModel = ReturnType<typeof useDraftDock>;

export function useDraftDock({ generating }: { generating: boolean }) {
  const { serverActiveGroups, groups, controller } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();
  const dispositionSnapshot = usePostApplySnapshot();
  const recovery = useProjectDraftApplyRecovery();
  const commandErrors = useDraftCommandErrors();

  const applyDraft = useCallback(
    (row: DockRow) => {
      return controller.disposeDrafts("apply", [
        { documentId: row.documentId, draftId: row.draft.draftId },
      ]);
    },
    [controller],
  );

  const rows = useMemo(() => dockRows(groups), [groups]);
  const serverActiveRows = useMemo(() => dockRows(serverActiveGroups), [serverActiveGroups]);

  const reviewRow = useCallback(
    (row: DockRow) => {
      if (!row.contextPath) return;
      openAiDraft({
        workId: controller.workId,
        documentId: row.documentId,
        draftId: row.draft.draftId,
        contextPath: row.contextPath,
        documentName: row.documentName ?? undefined,
        isNewDocument: row.isNewDocument,
      });
    },
    [controller.workId, openAiDraft],
  );

  // Row click opens the LIVE document (Review — the pill — opens the review
  // view; the row itself is a plain "take me to the file" affordance).
  const openContextUri = useChatContextNavigation();
  const openRow = useCallback(
    (row: DockRow) => {
      if (!openContextUri || !row.contextPath) return;
      openContextUri(contextUriFromWritePath(row.contextPath));
    },
    [openContextUri],
  );

  const model = {
    generating,
    rows,
    serverActiveCount: serverActiveRows.length,
    aggregateStats: aggregateDraftStats(serverActiveRows.map((row) => row.draft)),
    dispositionRows: projectDraftDispositionRows(dispositionSnapshot, controller.projectId),
    dispositionSnapshot,
    recovery,
    mounted:
      rows.length > 0 ||
      projectDraftDispositionRows(dispositionSnapshot, controller.projectId).length > 0,
    isBusy: controller.isDisposing,
    dispositionError: controller.dockDispositionError,
    /** A refused command on this row's draft, shown on the row it belongs to. */
    rowError: (row: DockRow) =>
      commandErrors[
        draftCommandErrorKey({ documentId: row.documentId, draftId: row.draft.draftId })
      ] ?? null,
    reviewRow,
    openRow,
    reviewFirst: () => {
      const first = rows[0];
      if (first) reviewRow(first);
    },
    applyRow: applyDraft,
    discardRow: (row: DockRow) =>
      controller.disposeDrafts("discard", [
        { documentId: row.documentId, draftId: row.draft.draftId },
      ]),
    startApplyAll: () => {
      void controller.disposeDrafts(
        "apply",
        rows.map((row) => ({
          documentId: row.documentId,
          draftId: row.draft.draftId,
        })),
      );
    },
    startDiscardAll: () => {
      void controller.disposeDrafts(
        "discard",
        rows.map((row) => ({
          documentId: row.documentId,
          draftId: row.draft.draftId,
        })),
      );
    },
  };
  return model;
}

export function DraftDock({ dock }: { dock: DraftDockModel }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingDiscardAll, setConfirmingDiscardAll] = useState(false);
  const refusedRowCount = dock.rows.filter((row) => dock.rowError(row) !== null).length;
  // A refusal on a row opens the strip so the writer sees it.
  useEffect(() => {
    if (refusedRowCount > 0) setExpanded(true);
  }, [refusedRowCount]);

  if (!dock.mounted) return null;

  const multi = dock.serverActiveCount > 1;
  const single = dock.serverActiveCount === 1 && dock.rows.length === 1;
  const firstPending = dock.rows[0] ?? null;
  const identity = single ? (dock.rows[0].documentName ?? t`Document`) : null;
  // One document: the error sits under the strip. Several: it sits on the
  // document's row, so the strip opens to show it.
  const stripError = single && firstPending ? dock.rowError(firstPending) : null;
  // The batch-level discard message repeats what a row already says.
  const batchError =
    dock.dispositionError === "discard-offline" && refusedRowCount > 0
      ? null
      : dock.dispositionError;

  return (
    <div
      className="mx-[var(--chat-space-block)] rounded-t-lg bg-dock-surface"
      data-draft-dock="settled"
    >
      {dock.rows.length > 0 ? (
        <>
          {/* The WHOLE strip is the expand/collapse target (multi only) — buttons
          intercept their own clicks below. Tiny chevron-only targets read as
          broken affordance. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the chevron button inside is the keyboard-accessible toggle; the row onClick is a mouse convenience. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: same — mouse-convenience toggle over a semantic inner button. */}
          <div
            onClick={multi ? () => setExpanded((value) => !value) : () => dock.reviewFirst()}
            className={cn(
              "flex min-h-7 items-center gap-[var(--chat-space-inline)] px-[var(--chat-card-pad-x)] text-caption text-prose-foreground",
              multi && "cursor-pointer transition-colors hover:bg-muted/50",
            )}
          >
            {multi ? (
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? t`Collapse changes` : t`Expand changes`}
                onClick={(event) => {
                  event.stopPropagation();
                  setExpanded((value) => !value);
                }}
                className="focus-ring -ml-0.5 grid size-4 shrink-0 place-items-center rounded-sm text-ink-subtle"
              >
                <ChevronRight
                  className={cn("size-3 transition-transform", expanded && "rotate-90")}
                  aria-hidden
                />
              </button>
            ) : null}
            <div className="flex min-w-0 flex-1 items-center gap-[var(--chat-space-inline)] overflow-hidden">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-jade-text" />
              {/* min() keeps the 12ch floor from padding short names with dead space */}
              <span className="min-w-[min(12ch,max-content)] shrink truncate">
                {single ? identity : <Trans>{dock.serverActiveCount} documents</Trans>}
              </span>
              {dock.aggregateStats ? (
                <span className="shrink-0 whitespace-nowrap text-ink-subtle">
                  <DraftStatsLabel stats={dock.aggregateStats} />
                </span>
              ) : null}
            </div>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: pure click fence so verb buttons don't also toggle the row. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: same — stopPropagation fence only, no interaction of its own. */}
            <div
              className="flex shrink-0 items-center gap-[var(--chat-space-inline)]"
              onClick={(event) => event.stopPropagation()}
            >
              {confirmingDiscardAll ? (
                <>
                  <span className="whitespace-nowrap text-ink-muted">
                    <Trans>Discard all changes?</Trans>
                  </span>
                  <QuietButton onClick={() => setConfirmingDiscardAll(false)}>
                    <Trans>Keep</Trans>
                  </QuietButton>
                  <QuietButton
                    onClick={() => {
                      setConfirmingDiscardAll(false);
                      dock.startDiscardAll();
                    }}
                    disabled={dock.isBusy}
                  >
                    <Trans>Discard</Trans>
                  </QuietButton>
                </>
              ) : (
                <>
                  <QuietButton
                    onClick={() => {
                      if (single && firstPending) dock.discardRow(firstPending);
                      else setConfirmingDiscardAll(true);
                    }}
                    disabled={dock.generating || dock.isBusy || !firstPending}
                  >
                    {single ? <Trans>Discard</Trans> : <Trans>Discard all</Trans>}
                  </QuietButton>
                  <QuietButton
                    onClick={() => {
                      if (single && firstPending) void dock.applyRow(firstPending).catch(() => {});
                      else dock.startApplyAll();
                    }}
                    disabled={dock.generating || dock.isBusy || !firstPending}
                  >
                    {single ? <Trans>Apply</Trans> : <Trans>Apply all</Trans>}
                  </QuietButton>
                  {firstPending ? (
                    <ReviewPill onClick={() => dock.reviewFirst()} disabled={dock.isBusy} />
                  ) : null}
                </>
              )}
            </div>
          </div>

          {batchError ? (
            <DockErrorLine code={batchError} />
          ) : stripError ? (
            <DockErrorLine code={stripError} />
          ) : null}

          {multi && expanded ? (
            <div>
              {dock.rows.map((row) => (
                <DockRowLine
                  key={row.documentId}
                  row={row}
                  error={dock.rowError(row)}
                  busy={dock.isBusy}
                  onOpen={() => dock.openRow(row)}
                  onReview={() => dock.reviewRow(row)}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {dock.dispositionRows.map((row) => (
        <div
          key={
            row.kind === "recovery"
              ? `recovery-${row.recovery.entryVersion}`
              : `unknown-${row.reservation.reservationVersion}`
          }
          className="flex min-h-8 items-center gap-[var(--chat-space-block)] border-border-subtle border-t px-[var(--chat-card-pad-x)] text-caption"
          data-draft-disposition={row.kind}
        >
          <span className="min-w-0 flex-1 truncate">
            {row.presentation.documentName ?? <Trans>Document</Trans>}
            {row.presentation.owningWorkLabel ? (
              <span className="ml-1 text-ink-subtle">({row.presentation.owningWorkLabel})</span>
            ) : null}
            {row.kind === "recovery" ? (
              <span className="ml-2 text-ink-subtle">
                {row.phase.kind === "disposing" ? (
                  row.phase.outcome === "writer-abandoned" ? (
                    <Trans>Finishing close</Trans>
                  ) : (
                    <Trans>Finishing reopening</Trans>
                  )
                ) : (
                  <Trans>Applied. Reopening live document.</Trans>
                )}
              </span>
            ) : (
              <span className="ml-2 text-ink-subtle">
                <Trans>Checking whether Apply finished.</Trans>
              </span>
            )}
          </span>
          {row.kind === "apply-outcome-unknown" ? (
            <QuietButton onClick={() => dock.recovery.checkApplyOutcome(row.reservation)}>
              <Trans>Check again</Trans>
            </QuietButton>
          ) : row.phase.kind === "disposing" ? (
            <QuietButton onClick={() => dock.recovery.finishDisposition(row.recovery)}>
              {row.phase.outcome === "writer-abandoned" ? (
                <Trans>Finish close</Trans>
              ) : (
                <Trans>Finish reopening</Trans>
              )}
            </QuietButton>
          ) : (
            <>
              <QuietButton onClick={() => dock.recovery.abandon(row.recovery)}>
                {row.recovery.identity.documentId &&
                dock.dispositionSnapshot.items.find(
                  (item) => item.entryVersion === row.recovery.entryVersion,
                )?.obligations.draftTab.kind === "draft-only" ? (
                  <Trans>Close</Trans>
                ) : (
                  <Trans>Stop</Trans>
                )}
              </QuietButton>
              {row.phase.kind === "awaiting-live" ? (
                <QuietButton onClick={() => dock.recovery.retry(row.recovery)}>
                  <Trans>Retry</Trans>
                </QuietButton>
              ) : null}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * One document row in the expanded dock. The WHOLE row is a click target that
 * opens the live document; the Review pill fences its own clicks and acts on
 * the pending changes instead.
 */
function DockRowLine({
  row,
  error,
  busy,
  onOpen,
  onReview,
}: {
  row: DockRow;
  error: InlineReviewMessageCode | null;
  busy: boolean;
  onOpen: () => void;
  onReview: () => void;
}) {
  const name = row.documentName ?? row.documentId;
  const stats = draftStats(row.draft);

  return (
    <>
      <DockRowShell onOpen={onOpen} className="text-prose-foreground">
        <span aria-hidden className="shrink-0 text-ink-subtle">
          ○
        </span>
        <span className="min-w-0 flex-1 truncate">
          {name}
          {stats ? (
            <>
              {" "}
              <DraftStatsLabel stats={stats} wordsSuffix={false} />
            </>
          ) : null}
        </span>
        {busy ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-ink-subtle" aria-hidden />
        ) : null}
        <RowClickFence className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <ReviewPill onClick={onReview} disabled={busy} />
        </RowClickFence>
      </DockRowShell>
      {error ? <DockErrorLine code={error} row /> : null}
    </>
  );
}

/** A refused command, in the strip's error voice. */
function DockErrorLine({ code, row = false }: { code: InlineReviewMessageCode; row?: boolean }) {
  return (
    <p
      className="border-border-subtle border-t px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] text-destructive text-micro"
      role="alert"
      {...{ [row ? "data-draft-dock-row-error" : "data-draft-dock-disposition-error"]: code }}
    >
      <ReviewMessageText code={code} />
    </p>
  );
}

/** Full-width dock row: hover wash + click opens the live document. */
function DockRowShell({
  onOpen,
  className,
  children,
}: {
  onOpen: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: document names remain reachable via the editor's file tree; the row click is a mouse convenience.
    // biome-ignore lint/a11y/noStaticElementInteractions: same.
    <div
      onClick={onOpen}
      className={cn(
        "group flex min-h-7 cursor-pointer items-center gap-[var(--chat-space-inline)] border-b border-border-subtle pr-[var(--chat-geometry-draft-inset)] pl-[var(--chat-geometry-draft-indent)] text-caption transition-colors last:border-b-0 hover:bg-muted",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Wraps row verbs so their clicks don't also fire the row's open action. */
function RowClickFence({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: pure stopPropagation fence, no interaction of its own.
    // biome-ignore lint/a11y/noStaticElementInteractions: same.
    <div className={className} onClick={(event) => event.stopPropagation()}>
      {children}
    </div>
  );
}

function ReviewPill({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="focus-ring inline-flex h-5 shrink-0 items-center rounded-sm bg-primary px-2 text-caption font-semibold text-primary-foreground disabled:opacity-50"
    >
      <Trans>Review draft</Trans>
    </button>
  );
}

/** Quiet text verb — never destructive-colored. */
function QuietButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="focus-ring shrink-0 whitespace-nowrap rounded-sm px-[var(--chat-space-block)] py-0.5 text-ink-muted hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}
