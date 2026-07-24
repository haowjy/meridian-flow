/**
 * DraftDock — the composer-attached strip that is the SINGLE actionable surface
 * for a Work's pending AI changes.
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
 * All visibility derives from `DraftReviewProvider` state (never raw queries),
 * so the dock, the editor bar, and the transcript can never disagree about what
 * is pending.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";
import { contextUriFromWritePath } from "@/lib/context-uri";
import { cn } from "@/lib/utils";
import { useChatContextNavigation } from "./ChatContextNavigation";
import { useDraftReview } from "./DraftReviewProvider";
import { type DockRow, dockRows } from "./docked-drafts";
import { aggregateDraftStats, DraftStatsLabel, draftStats } from "./draft-stats";
import { useAiDraftLauncher } from "./useAiDraftLauncher";

export type DraftDockModel = ReturnType<typeof useDraftDock>;

export function useDraftDock({ generating }: { generating: boolean }) {
  const { groups, controller, nowMs } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();

  const applyDraft = useCallback(
    (row: DockRow) => {
      return controller.disposeDrafts("apply", [
        { documentId: row.documentId, draftId: row.draft.draftId },
      ]);
    },
    [controller],
  );

  const rows = useMemo(() => dockRows(groups, nowMs), [groups, nowMs]);
  const pendingRows = useMemo(() => rows.filter((row) => row.state === "pending"), [rows]);

  const reviewRow = useCallback(
    (row: DockRow) => {
      openAiDraft(
        {
          documentId: row.documentId,
          contextPath: row.contextPath ?? undefined,
          documentName: row.documentName ?? undefined,
          isNewDocument: row.isNewDocument,
        },
        row.draft.draftId,
      );
    },
    [openAiDraft],
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
    pendingRows,
    reviewedCount: rows.filter((row) => row.state === "reviewed").length,
    totalCount: rows.length,
    aggregateStats: aggregateDraftStats(rows.map((row) => row.draft)),
    mounted: pendingRows.length > 0,
    inFlightDraftId: null,
    isBusy: controller.isDisposing,
    needsRereview: controller.needsRereview,
    applyRefusal: controller.applyRefusal,
    reviewRow,
    openRow,
    reviewFirst: () => {
      const first = pendingRows[0];
      if (first) reviewRow(first);
    },
    applyRow: applyDraft,
    discardRow: (row: DockRow) => controller.reject(row.documentId, row.draft.draftId),
    startApplyAll: () => {
      void controller.disposeDrafts(
        "apply",
        pendingRows.map((row) => ({
          documentId: row.documentId,
          draftId: row.draft.draftId,
        })),
      );
    },
    startDiscardAll: () => {
      void controller.disposeDrafts(
        "discard",
        pendingRows.map((row) => ({
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

  if (!dock.mounted) return null;

  const multi = dock.rows.length > 1;
  const guided = dock.reviewedCount >= 1 && dock.pendingRows.length >= 1;
  const single = dock.rows.length === 1;
  const firstPending = dock.pendingRows[0] ?? null;
  const identity = single ? (dock.rows[0].documentName ?? t`Document`) : null;

  function verbBusy(row: DockRow): boolean {
    return dock.isBusy || dock.inFlightDraftId === row.draft.draftId;
  }

  return (
    <div className="mx-2 rounded-t-lg bg-dock-surface" data-draft-dock="settled">
      {/* The WHOLE strip is the expand/collapse target (multi only) — buttons
          intercept their own clicks below. Tiny chevron-only targets read as
          broken affordance. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the chevron button inside is the keyboard-accessible toggle; the row onClick is a mouse convenience. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same — mouse-convenience toggle over a semantic inner button. */}
      <div
        onClick={multi ? () => setExpanded((value) => !value) : () => dock.reviewFirst()}
        className={cn(
          "flex min-h-7 items-center gap-1.5 px-2.5 text-caption text-prose-foreground",
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
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              dock.needsRereview ? "bg-status-warning" : "bg-jade-text",
            )}
          />
          {/* min() keeps the 12ch floor from padding short names with dead space */}
          <span className="min-w-[min(12ch,max-content)] shrink truncate">
            {single ? identity : <Trans>{dock.rows.length} documents</Trans>}
          </span>
          {dock.aggregateStats ? (
            <span className="shrink-0 whitespace-nowrap text-ink-subtle">
              <DraftStatsLabel stats={dock.aggregateStats} />
            </span>
          ) : null}
          {guided ? (
            <span className="@max-[360px]:hidden shrink-0 whitespace-nowrap text-ink-subtle">
              <Trans>
                {dock.reviewedCount} of {dock.totalCount} reviewed
              </Trans>
            </span>
          ) : null}
          {dock.needsRereview ? (
            <span
              className="shrink-0 rounded-full border border-warning-border bg-warning-bg px-1.5 text-warning-foreground"
              data-draft-dock-status="needs-rereview"
            >
              <Trans>needs re-review</Trans>
            </span>
          ) : null}
        </div>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: pure click fence so verb buttons don't also toggle the row. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: same — stopPropagation fence only, no interaction of its own. */}
        <div
          className="flex shrink-0 items-center gap-0.5"
          onClick={(event) => event.stopPropagation()}
        >
          {confirmingDiscardAll ? (
            <>
              <span className="whitespace-nowrap text-ink-muted">
                <Trans>Discard all changes?</Trans>
              </span>
              <QuietButton
                onClick={() => {
                  setConfirmingDiscardAll(false);
                  dock.startDiscardAll();
                }}
                disabled={dock.isBusy}
              >
                <Trans>Discard</Trans>
              </QuietButton>
              <span aria-hidden className="text-ink-subtle">
                ·
              </span>
              <QuietButton onClick={() => setConfirmingDiscardAll(false)}>
                <Trans>Keep</Trans>
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
              {!guided && firstPending ? (
                <ReviewPill onClick={() => dock.reviewFirst()} disabled={dock.isBusy} />
              ) : null}
            </>
          )}
        </div>
      </div>

      {dock.applyRefusal ? <DraftApplyRefusalNotice refusal={dock.applyRefusal} /> : null}

      {multi && expanded ? (
        <div>
          {dock.rows.map((row) => (
            <DockRowLine
              key={row.documentId}
              row={row}
              reviewAlways={guided && row.draft.draftId === firstPending?.draft.draftId}
              busy={verbBusy(row)}
              onOpen={() => dock.openRow(row)}
              onReview={() => dock.reviewRow(row)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function DraftApplyRefusalNotice({
  refusal,
}: {
  refusal: NonNullable<DraftDockModel["applyRefusal"]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const explanationId = useId();
  const explanation =
    refusal.reason === "stale_draft"
      ? t`This draft was updated after you opened it.`
      : refusal.reason === "protected_resurrection"
        ? t`Applying would bring back text you deleted:`
        : t`The chapter changed after this draft was written:`;

  return (
    <div
      className="border-border-subtle border-b bg-muted text-caption text-prose-foreground"
      data-draft-apply-refusal={refusal.reason}
      data-draft-apply-refusal-expanded={expanded}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={explanationId}
        onClick={() => setExpanded((value) => !value)}
        className="focus-ring flex w-full items-center gap-1.5 px-3 py-2 text-left hover:bg-card"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
          aria-hidden
        />
        <span className="font-medium">
          <Trans>Not applied</Trans>
        </span>
      </button>
      {expanded ? (
        <div id={explanationId} className="space-y-1 px-3 pb-2" data-draft-apply-refusal-details>
          <p className="text-ink-muted" data-draft-apply-refusal-explanation>
            {explanation}
          </p>
          {refusal.passages.map((passage) => (
            <p key={passage.body} className="whitespace-pre-wrap text-prose-foreground">
              {passage.body}
            </p>
          ))}
        </div>
      ) : null}
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
  reviewAlways,
  busy,
  onOpen,
  onReview,
}: {
  row: DockRow;
  reviewAlways: boolean;
  busy: boolean;
  onOpen: () => void;
  onReview: () => void;
}) {
  const name = row.documentName ?? row.documentId;
  const stats = draftStats(row.draft);

  if (row.state === "reviewed") {
    return (
      <DockRowShell onOpen={onOpen} className="text-ink-subtle">
        <span aria-hidden className="shrink-0 text-jade-text">
          ✓
        </span>
        <span className="min-w-0 flex-1 truncate">
          <Trans>{name} · reviewed</Trans>
        </span>
      </DockRowShell>
    );
  }

  return (
    <DockRowShell
      onOpen={onOpen}
      className={cn("text-prose-foreground", reviewAlways && "bg-jade-text/[0.06]")}
    >
      <span aria-hidden className="shrink-0 text-ink-subtle">
        ○
      </span>
      <span className="min-w-0 flex-1 truncate">
        {name}
        {stats ? (
          <>
            <span className="text-ink-subtle" aria-hidden>
              {" · "}
            </span>
            <DraftStatsLabel stats={stats} wordsSuffix={false} />
          </>
        ) : null}
      </span>
      {busy ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-ink-subtle" aria-hidden />
      ) : null}
      <RowClickFence
        className={cn(
          "shrink-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
          reviewAlways ? "opacity-100" : "opacity-0",
        )}
      >
        <ReviewPill onClick={onReview} disabled={busy} />
      </RowClickFence>
    </DockRowShell>
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
        "group flex min-h-7 cursor-pointer items-center gap-1.5 border-b border-border-subtle pr-2.5 pl-7 text-caption transition-colors last:border-b-0 hover:bg-muted",
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
      className="focus-ring inline-flex h-5 shrink-0 items-center rounded-sm bg-primary px-2.5 text-caption font-semibold text-primary-foreground disabled:opacity-50"
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
      className="focus-ring shrink-0 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-ink-muted hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}
