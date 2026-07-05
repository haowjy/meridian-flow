/**
 * DraftDock — the composer-attached strip that is the SINGLE actionable surface
 * for a Work's pending AI changes.
 *
 * It is chrome, not a card: a thin strip that shares the composer's border box
 * (no lift, no shadow, radius on the shared outer container only). One instance,
 * work-scoped, updates in place across turns; nothing about pending changes ever
 * renders in the transcript. States mirror the design gallery A1–A8:
 * generating → settled (single / multi) → expanded checklist → guided
 * progression → all-reviewed fade-out; plus the per-row cannot_place warning.
 *
 * All visibility derives from `DraftReviewProvider` state (never raw queries),
 * so the dock, the editor bar, and the transcript can never disagree about what
 * is pending.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useDraftReview } from "./DraftReviewProvider";
import { type DockRow, dockRows } from "./docked-drafts";
import { aggregateDraftStats, DraftStatsLabel, draftStats } from "./draft-stats";
import { useEphemeralUndoStore } from "./ephemeral-undo-store";
import { useAiDraftLauncher } from "./useAiDraftLauncher";

const TERMINAL_FLASH_MS = 1500;

export type DraftDockModel = ReturnType<typeof useDraftDock>;

export function useDraftDock({
  generating,
  hostTurnId = null,
}: {
  generating: boolean;
  hostTurnId?: string | null;
}) {
  const { groups, controller, nowMs } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();
  const markEphemeralUndo = useEphemeralUndoStore((state) => state.mark);

  // Apply flashes the "just applied — Undo?" chip on the latest turn line.
  // Marked via onApplied so a failed/cannot_place accept never offers an Undo
  // for a change that was never made.
  const applyDraft = useCallback(
    (row: DockRow) => {
      controller.accept(row.documentId, row.draft.draftId, {
        onApplied: () => {
          if (!controller.threadId) return;
          markEphemeralUndo({
            threadId: controller.threadId,
            hostTurnId,
            projectId: controller.projectId,
            workId: controller.workId,
            documentId: row.documentId,
            draftId: row.draft.draftId,
            documentName: row.documentName,
          });
        },
      });
    },
    [controller, hostTurnId, markEphemeralUndo],
  );

  const rows = useMemo(() => dockRows(groups, nowMs), [groups, nowMs]);
  const pendingRows = useMemo(() => rows.filter((row) => row.state === "pending"), [rows]);
  const reviewedRows = useMemo(() => rows.filter((row) => row.state === "reviewed"), [rows]);
  const hasPending = pendingRows.length > 0;
  const pendingKey = pendingRows.map((row) => row.draft.draftId).join("|");

  // All-reviewed flash: when the last active draft goes terminal, hold the
  // "✓ All changes reviewed" strip briefly, then unmount. Instant unmount under
  // reduced motion.
  const [terminalFlash, setTerminalFlash] = useState(false);
  const hadPendingRef = useRef(false);
  useEffect(() => {
    const hadPending = hadPendingRef.current;
    hadPendingRef.current = hasPending;
    if (hasPending) {
      setTerminalFlash(false);
      return;
    }
    if (!hadPending) return;
    if (prefersReducedMotion()) {
      setTerminalFlash(false);
      return;
    }
    setTerminalFlash(true);
    const id = window.setTimeout(() => setTerminalFlash(false), TERMINAL_FLASH_MS);
    return () => window.clearTimeout(id);
  }, [hasPending]);

  // Sequential Apply all / Discard all. The shared accept/reject mutation and
  // its `isPending` gate make concurrent disposition unsafe, so we run one
  // draft at a time. Bulk completion is based on observed row transitions: a
  // row must leave `pendingRows` after the mutation settles. If it stays active
  // (for example `cannot_place`), the bulk run stops and the remaining rows stay
  // individually actionable.
  const [bulk, setBulk] = useState<{
    mode: "apply" | "discard";
    inFlightDraftId: string | null;
    observedPending: boolean;
  } | null>(null);
  const dispatchedPendingKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bulk) {
      dispatchedPendingKeyRef.current = null;
      return;
    }
    if (pendingRows.length === 0) {
      setBulk(null);
      return;
    }
    if (controller.isPending) {
      if (bulk.inFlightDraftId && !bulk.observedPending) {
        setBulk({ ...bulk, observedPending: true });
      }
      return;
    }
    if (bulk.inFlightDraftId) {
      if (!bulk.observedPending) return;
      const stillPending = pendingRows.some((row) => row.draft.draftId === bulk.inFlightDraftId);
      dispatchedPendingKeyRef.current = null;
      if (stillPending) {
        setBulk(null);
        return;
      }
      setBulk({ mode: bulk.mode, inFlightDraftId: null, observedPending: false });
      return;
    }
    if (dispatchedPendingKeyRef.current === pendingKey) return;
    const next = pendingRows[0];
    if (!next) return;
    dispatchedPendingKeyRef.current = pendingKey;
    setBulk({ mode: bulk.mode, inFlightDraftId: next.draft.draftId, observedPending: false });
    if (bulk.mode === "apply") applyDraft(next);
    else controller.reject(next.documentId, next.draft.draftId);
    // pendingKey stands in for the pendingRows identity: the pump advances only
    // when the pending list actually changes, not on every unrelated re-render.
  }, [bulk, pendingKey, pendingRows, controller.isPending, applyDraft, controller.reject]);

  const cannotPlace = controller.cannotPlaceDraft;
  const isCannotPlaceRow = useCallback(
    (row: DockRow) =>
      cannotPlace?.documentId === row.documentId && cannotPlace.draftId === row.draft.draftId,
    [cannotPlace],
  );

  const reviewRow = useCallback(
    (row: DockRow) => {
      openAiDraft(
        {
          documentId: row.documentId,
          contextPath: row.contextPath ?? undefined,
          documentName: row.documentName ?? undefined,
        },
        row.draft.draftId,
      );
    },
    [openAiDraft],
  );

  const model = {
    generating,
    rows,
    pendingRows,
    reviewedRows,
    hasPending,
    reviewedCount: reviewedRows.length,
    totalCount: rows.length,
    aggregateStats: aggregateDraftStats(rows.map((row) => row.draft)),
    mounted: hasPending || terminalFlash || generating,
    phase: (generating
      ? "generating"
      : hasPending
        ? "settled"
        : terminalFlash
          ? "terminal"
          : "hidden") as "generating" | "settled" | "terminal" | "hidden",
    bulkActive: bulk !== null,
    inFlightDraftId: bulk?.inFlightDraftId ?? null,
    isBusy: controller.isPending || bulk !== null,
    isCannotPlaceRow,
    reviewRow,
    reviewFirst: () => {
      const first = pendingRows[0];
      if (first) reviewRow(first);
    },
    applyRow: applyDraft,
    discardRow: (row: DockRow) => controller.reject(row.documentId, row.draft.draftId),
    startApplyAll: () => setBulk({ mode: "apply", inFlightDraftId: null, observedPending: false }),
    startDiscardAll: () =>
      setBulk({ mode: "discard", inFlightDraftId: null, observedPending: false }),
  };
  return model;
}

export function DraftDock({ dock }: { dock: DraftDockModel }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingDiscardAll, setConfirmingDiscardAll] = useState(false);

  if (!dock.mounted) return null;

  if (dock.phase === "terminal") {
    return (
      <div
        className="flex min-h-7 items-center justify-center bg-sidebar text-caption font-medium text-jade-text motion-safe:animate-out motion-safe:fade-out motion-safe:duration-1000 motion-safe:fill-mode-forwards"
        data-draft-dock="terminal"
      >
        <Trans>✓ All changes reviewed</Trans>
      </div>
    );
  }

  if (dock.phase === "generating") {
    const editing = dock.pendingRows[0];
    return (
      <div
        className="flex min-h-7 items-center gap-1.5 bg-sidebar px-2.5 text-caption text-ink-strong"
        data-draft-dock="generating"
      >
        <Loader2 className="size-3 shrink-0 animate-spin text-jade-text" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {editing?.documentName ? (
            <Trans>Editing · {editing.documentName}</Trans>
          ) : (
            <Trans>Editing changes…</Trans>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-1 text-ink-subtle">
          <span aria-hidden>
            <Trans>Apply all</Trans>
          </span>
          <span aria-hidden>·</span>
          <span aria-hidden>
            <Trans>Discard all</Trans>
          </span>
        </div>
      </div>
    );
  }

  // Settled.
  const multi = dock.rows.length > 1;
  const guided = dock.reviewedCount >= 1 && dock.pendingRows.length >= 1;
  const single = dock.rows.length === 1;
  const firstPending = dock.pendingRows[0] ?? null;
  const identity = single ? (dock.rows[0].documentName ?? t`Document`) : null;

  function verbBusy(row: DockRow): boolean {
    return dock.isBusy || dock.inFlightDraftId === row.draft.draftId;
  }

  return (
    <div className="bg-sidebar" data-draft-dock="settled">
      {/* The WHOLE strip is the expand/collapse target (multi only) — buttons
          intercept their own clicks below. Tiny chevron-only targets read as
          broken affordance. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the chevron button inside is the keyboard-accessible toggle; the row onClick is a mouse convenience. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same — mouse-convenience toggle over a semantic inner button. */}
      <div
        onClick={multi ? () => setExpanded((value) => !value) : undefined}
        className={cn(
          "flex min-h-7 items-center gap-1.5 border-b border-border-subtle px-2.5 text-caption text-ink-strong",
          multi && "cursor-pointer transition-colors hover:bg-sidebar-accent",
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
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-jade-text" />
          {/* min() keeps the 12ch floor from padding short names with dead space */}
          <span className="min-w-[min(12ch,max-content)] shrink truncate">
            {single ? identity : <Trans>{dock.rows.length} documents</Trans>}
          </span>
          {dock.aggregateStats ? (
            <span className="shrink-0 whitespace-nowrap">
              <span className="text-ink-subtle" aria-hidden>
                ·{" "}
              </span>
              <DraftStatsLabel stats={dock.aggregateStats} />
            </span>
          ) : null}
          {guided ? (
            <span className="@max-[360px]:hidden shrink-0 whitespace-nowrap text-ink-subtle">
              <Trans>
                · {dock.reviewedCount} of {dock.totalCount} reviewed
              </Trans>
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
              {!guided && firstPending ? (
                <ReviewPill onClick={() => dock.reviewFirst()} disabled={dock.isBusy} />
              ) : null}
              <QuietButton
                onClick={() => {
                  if (single && firstPending) dock.applyRow(firstPending);
                  else dock.startApplyAll();
                }}
                disabled={dock.isBusy || !firstPending}
              >
                {single ? <Trans>Apply</Trans> : <Trans>Apply all</Trans>}
              </QuietButton>
              <QuietButton
                onClick={() => {
                  if (single && firstPending) dock.discardRow(firstPending);
                  else setConfirmingDiscardAll(true);
                }}
                disabled={dock.isBusy || !firstPending}
              >
                {single ? <Trans>Discard</Trans> : <Trans>Discard all</Trans>}
              </QuietButton>
            </>
          )}
        </div>
      </div>

      {multi && expanded ? (
        <div>
          {dock.rows.map((row) => (
            <DockRowLine
              key={row.documentId}
              row={row}
              cannotPlace={dock.isCannotPlaceRow(row)}
              reviewAlways={guided && row.draft.draftId === firstPending?.draft.draftId}
              busy={verbBusy(row)}
              onReview={() => dock.reviewRow(row)}
              onDiscard={() => dock.discardRow(row)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DockRowLine({
  row,
  cannotPlace,
  reviewAlways,
  busy,
  onReview,
  onDiscard,
}: {
  row: DockRow;
  cannotPlace: boolean;
  reviewAlways: boolean;
  busy: boolean;
  onReview: () => void;
  onDiscard: () => void;
}) {
  const name = row.documentName ?? row.documentId;
  const stats = draftStats(row.draft);

  if (cannotPlace) {
    return (
      <div className="flex min-h-7 items-center gap-1.5 border-b border-border-subtle pr-2.5 pl-7 text-caption text-ink-muted last:border-b-0">
        <span aria-hidden className="shrink-0 text-gold-text">
          ⚠
        </span>
        <span className="min-w-0 flex-1 truncate">
          <Trans>{name} · can't be placed — the manuscript moved on</Trans>
        </span>
        <QuietButton onClick={onDiscard} disabled={busy}>
          <Trans>Discard</Trans>
        </QuietButton>
      </div>
    );
  }

  if (row.state === "reviewed") {
    return (
      <div className="flex min-h-7 items-center gap-1.5 border-b border-border-subtle pr-2.5 pl-7 text-caption text-ink-subtle last:border-b-0">
        <span aria-hidden className="shrink-0 text-jade-text">
          ✓
        </span>
        <span className="min-w-0 flex-1 truncate">
          <Trans>{name} · reviewed</Trans>
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex min-h-7 items-center gap-1.5 border-b border-border-subtle pr-2.5 pl-7 text-caption text-ink-strong last:border-b-0",
        reviewAlways && "bg-jade-text/[0.06]",
      )}
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
      <div
        className={cn(
          "shrink-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
          reviewAlways ? "opacity-100" : "opacity-0",
        )}
      >
        <ReviewPill onClick={onReview} disabled={busy} />
      </div>
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
      <Trans>Review</Trans>
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

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
