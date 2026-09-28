/** Renders the transcript and owns its scroll viewport. */

import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/protocol";
import type { CompactionUndoAvailability, ThreadPhase } from "@meridian/contracts/threads";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import type { ChangeTrailShell } from "@/client/change-trails";
import { Button } from "@/components/ui/button";
import { AssistantTurn } from "./AssistantTurn";
import { ChatColumn } from "./ChatColumn";
import { useChatSurfaceBottomInset } from "./ChatSurface";
import type { InterruptRespondRequest } from "./CustomBlockRenderer";
import { CompactionDivider } from "./compaction/CompactionDivider";
import { answeredControlIds } from "./compaction/compaction-model";
import { QueuedControlRows } from "./compaction/QueuedControlRows";
import type { QueuedControl } from "./compaction/thread-controls";
import type { ThreadControls } from "./compaction/useThreadControls";
import { HandoffBriefCard } from "./derivation/HandoffBriefCard";
import { isOptimisticSeed } from "./derivation/handoff-seed";
import { ForkPointRule, InheritedSourceHeader } from "./derivation/InheritedMarks";
import type { InheritedView } from "./derivation/inherited-view";
import { buildTranscriptModel, type InheritedMark, type TranscriptRow } from "./transcript-model";

export { continuesResponse } from "./transcript-model";

import { UserTurn, type UserTurnRecovery } from "./UserTurn";
import { useChangeTrailNavigation } from "./useChangeTrailNavigation";
import { useChatFollowScroll } from "./useChatFollowScroll";
import type { FailedSendRetry } from "./useThreadHandoff";
import { useTurnRevealLanding } from "./useTurnRevealLanding";

export type TurnListProps = {
  threadId: string;
  /** Settled history with the live turn merged in by id, oldest first. */
  turns: Turn[];
  historySettled: boolean;
  /** Background subagents are still running; their notification will wake the latest reply. */
  awaitingSubagents?: boolean;
  /** Monotonic submit signal: new local messages intentionally reacquire tail-follow. */
  tailFollowRevision: number;
  /** Accessible label for the scroll log region. */
  ariaLabel: string;
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  failedSendRetry?: FailedSendRetry | null;
  changeTrails?: Record<string, ChangeTrailShell>;
  /** Recovered ambiguous submissions, keyed by the restored user turn id. */
  submissionRecoveryByTurnId?: ReadonlyMap<string, UserTurnRecovery>;
  queuedWriterTurnIds?: ReadonlySet<string>;
  /** Writer controls: queued `/compact` and undo, withdrawal, and Stop on a pending divider. */
  controls?: ThreadControls | null;
  /** Snapshot advice for the one local divider that can be undone. */
  compactionUndo?: CompactionUndoAvailability;
  /** The live lease phase while the thread is awake. */
  phase?: ThreadPhase | null;
  /** A fork's frozen prefix from its source, rendered read-only above its own turns. */
  inherited?: InheritedView | null;
  threadUsage?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheReportedInputTokens: number;
    cacheReportedCalls: number;
    cacheWriteTokens: number;
    outputTokens: number;
    cacheResets: number;
  } | null;
};

/** A virtual row: a transcript row, or the queued controls at the tail. */
type ListRow = TranscriptRow | { kind: "queued-controls"; controls: readonly QueuedControl[] };

const QUEUED_CONTROLS_KEY = "queued-controls";
const NO_CONTROLS: readonly QueuedControl[] = [];

/** Estimated row height before measurement; corrected by `measureElement`. */
const ESTIMATED_TURN_HEIGHT = 160;
/** Top breathing room above the first turn (virtual paddingStart, px). */
const TOP_INSET = 24;

export function TurnList({
  threadId,
  turns,
  historySettled,
  awaitingSubagents = false,
  tailFollowRevision,
  ariaLabel,
  onRespondToInterrupt,
  failedSendRetry = null,
  changeTrails = {},
  submissionRecoveryByTurnId,
  queuedWriterTurnIds,
  controls = null,
  compactionUndo = null,
  phase = null,
  inherited = null,
  threadUsage = null,
}: TurnListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const navigateToChange = useChangeTrailNavigation(threadId);
  const bottomInset = useChatSurfaceBottomInset();
  const inheritedTranscript = inherited?.transcript ?? null;
  const transcript = useMemo(
    () => buildTranscriptModel(turns, awaitingSubagents, inheritedTranscript),
    [turns, awaitingSubagents, inheritedTranscript],
  );
  const visibleTurns = transcript.visibleTurns;
  const lastAssistantIdx = findLastAssistantIndex(visibleTurns);
  // Undo items render on the divider they target; everything else still
  // waiting sits at the tail, after the newest turn (R5: no position yet).
  const { undoByDividerId, tailControls } = useMemo(() => {
    const undoByDividerId = new Map<string, QueuedControl>();
    const tailControls: QueuedControl[] = [];
    const answered = answeredControlIds(turns);
    const dividerIds = new Set(
      transcript.rows.flatMap((row) => (row.kind === "compaction" ? [row.turn.id] : [])),
    );
    for (const control of controls?.queued ?? NO_CONTROLS) {
      if (control.control.kind === "compaction_undo") {
        const target = control.control.compactionTurnId;
        if (dividerIds.has(target)) {
          // The marker U tells an answered undo's story; an active request
          // outranks a settled withdrawal note on the same divider.
          const current = undoByDividerId.get(target);
          if (!answered.has(control.id) && (!current || !isSettledControl(control)))
            undoByDividerId.set(target, control);
          continue;
        }
      }
      if (answered.has(control.id)) continue;
      tailControls.push(control);
    }
    return { undoByDividerId, tailControls };
  }, [controls?.queued, transcript.rows, turns]);
  // The server refuses a second brief while one waits, so the card hides Retry.
  const briefRetryPending = tailControls.some(
    (control) => control.control.kind === "handoff_brief" && isActiveControl(control),
  );
  const listRows = useMemo<ListRow[]>(
    () =>
      tailControls.length
        ? [...transcript.rows, { kind: "queued-controls", controls: tailControls }]
        : transcript.rows,
    [tailControls, transcript.rows],
  );
  const { continuing, partsByFinalTurnId } = transcript;
  const byTurnId = useMemo(() => {
    const byTurnId = new Map<string, ChangeTrailShell>();
    for (const shell of Object.values(changeTrails)) {
      if (shell.owner.kind === "turn") byTurnId.set(shell.owner.turnId, shell);
    }
    return byTurnId;
  }, [changeTrails]);

  const virtualizer = useVirtualizer({
    count: listRows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    getItemKey: (index) => {
      const row = listRows[index];
      if (!row) return index;
      return row.kind === "queued-controls" ? QUEUED_CONTROLS_KEY : row.turn.id;
    },
    overscan: 8,
    paddingStart: TOP_INSET,
    // Clear the pinned composer AND align the true scroll end with the last turn.
    paddingEnd: bottomInset,
  });

  // Preserve the reader's place when a row ENTIRELY above the viewport changes
  // height (a disclosure expands, an image/code block renders). Two traps here:
  //   1. This is an INSTANCE property in virtual-core@3.17, not an option —
  //      passing it in the options object is silently ignored (react-virtual's
  //      option type omits it for the same reason). Assign it on the instance.
  //   2. The row must be FULLY above (`item.end`, not the default `item.start`):
  //      a straddling row grows below the reader's eyes (the streaming tail row
  //      while scrolled a short way up inside it), and compensating that growth
  //      slides the view back down toward the live edge — a creep that silently
  //      re-captures follow. `item` carries the pre-resize measurement, which is
  //      exactly what "was it above the viewport" should be judged against.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item: VirtualItem) =>
    item.end <= (viewportRef.current?.scrollTop ?? 0);

  // Turn stage of a conversation reveal. The transcript owns the landing (and
  // the verdict when the turn isn't here); the scroll capability stays here.
  useTurnRevealLanding({
    threadId,
    turns: visibleTurns,
    // The launch card lives in the origin turn; only "latest" follows the child forward.
    resolveTurnId: (turnId, subagentThreadId, subagentBlock) =>
      subagentThreadId && subagentBlock !== "card"
        ? transcript.resolveRevealTurnId(subagentThreadId, turnId)
        : turnId,
    historySettled,
    viewportRef,
    scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: "center" }),
  });

  // Follow policy. `getTotalSize()` is the content height AND the revision: it is
  // the height the virtualized list scrolls over, and it changes on turn append,
  // on measured streaming-row growth, and on composer-inset change — each change
  // re-renders this component, so the follow pin fires before paint. Passing the
  // height (not a bare counter) lets the pin compute the bottom without reading
  // `scrollHeight`, which would force a layout on every revision.
  // The thread opens in `follow`, so the very first pin anchors to the newest turn.
  const { mode, enterFollow } = useChatFollowScroll({
    scrollRef: viewportRef,
    contentHeight: virtualizer.getTotalSize(),
  });

  // Reacquire follow when the user submits (each local message bumps the revision).
  useEffect(() => {
    if (tailFollowRevision === 0) return;
    enterFollow();
  }, [tailFollowRevision, enterFollow]);

  const renderTranscriptRow = useCallback(
    (row: TranscriptRow, idx: number) => {
      const turn = row.turn;
      // Inherited rows are the source's history: read-only, and owned by the source.
      const local = !row.inherited;
      if (row.kind === "compaction") {
        return (
          <CompactionDivider
            turn={turn}
            undo={row.undo}
            undoAvailability={local ? compactionUndo : null}
            queuedUndo={local ? (undoByDividerId.get(turn.id) ?? null) : null}
            phase={local ? phase : null}
            stopping={local && (controls?.stoppingTurnIds.has(turn.id) ?? false)}
            onStop={local ? controls?.stop : undefined}
            onUndo={
              local && controls
                ? (compactionTurnId) =>
                    controls.enqueue({ kind: "compaction_undo", compactionTurnId })
                : undefined
            }
            onWithdraw={local ? controls?.withdraw : undefined}
            onRetry={local ? controls?.retry : undefined}
          />
        );
      }
      if (row.kind === "handoff-seed") {
        const live = local && !isOptimisticSeed(turn) && controls;
        return (
          <HandoffBriefCard
            turn={turn}
            latest={row.latest}
            retryPending={briefRetryPending}
            stopping={controls?.stoppingTurnIds.has(turn.id) ?? false}
            phase={local ? phase : null}
            onStop={live ? (turnId) => live.stop(turnId, "brief") : undefined}
            onRetry={live ? () => live.enqueue({ kind: "handoff_brief" }) : undefined}
          />
        );
      }
      if (turn.role === "user") {
        return (
          <UserTurn
            turn={turn}
            submissionRecovery={local ? submissionRecoveryByTurnId?.get(turn.id) : undefined}
            queued={local && queuedWriterTurnIds?.has(turn.id)}
          />
        );
      }
      return (
        <AssistantTurn
          threadId={row.inherited?.ownerThreadId ?? threadId}
          turn={turn}
          responseParts={partsByFinalTurnId.get(turn.id)}
          threadUsage={local ? threadUsage : null}
          deliveryEvents={transcript.deliveryEventsFor(turn.id)}
          isLatestAssistant={idx === lastAssistantIdx}
          // A divider is a row: once one follows a failed reply, that failure is
          // history. The queued-controls tail is not a row and never counts.
          endsTranscript={idx === visibleTurns.length - 1}
          continuesResponse={continuing[idx] ?? false}
          failedSendRetry={
            local && turn.id === failedSendRetry?.turnId ? failedSendRetry.retry : undefined
          }
          onRespondToInterrupt={local ? onRespondToInterrupt : undefined}
          changeTrail={local ? byTurnId.get(turn.id) : undefined}
          navigateToChange={navigateToChange}
        />
      );
    },
    [
      briefRetryPending,
      byTurnId,
      compactionUndo,
      controls,
      phase,
      undoByDividerId,
      failedSendRetry,
      lastAssistantIdx,
      navigateToChange,
      onRespondToInterrupt,
      submissionRecoveryByTurnId,
      queuedWriterTurnIds,
      threadId,
      threadUsage,
      transcript,
      visibleTurns.length,
      continuing,
      partsByFinalTurnId,
    ],
  );

  const renderRow = useCallback(
    (row: ListRow, idx: number) => {
      if (row.kind === "queued-controls") {
        return (
          <QueuedControlRows
            controls={row.controls}
            onWithdraw={controls?.withdraw}
            onRetry={controls?.retry}
          />
        );
      }
      const content = renderTranscriptRow(row, idx);
      return row.inherited ? (
        <InheritedRow mark={row.inherited} owners={inherited?.owners ?? null}>
          {content}
        </InheritedRow>
      ) : (
        content
      );
    },
    [controls, inherited?.owners, renderTranscriptRow],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={viewportRef}
        role="log"
        aria-label={ariaLabel}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: transcript is a scroll region — focusable so keyboard users can scroll it (arrows/PageUp/Down).
        tabIndex={0}
        // overflow-x-hidden: `overflow-y:auto` forces the x-axis from `visible` to
        // `auto` (CSS spec), giving an implicit horizontal scroll/rubber-band range we
        // never want — code blocks scroll internally. min-w-0 keeps children from
        // widening the flex column.
        // [overflow-anchor:none]: the virtualizer is the single scroll owner and does
        // its own scrollTop compensation for above-viewport resizes; browser native
        // scroll anchoring would be a competing second owner, double-correcting and
        // leaving the reader's place off. Disable it so TanStack alone drives scroll.
        className="chat-scroll-fade-bottom size-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none]"
      >
        <ChatColumn>
          <ol
            aria-label="Chat turns"
            data-chat-virtual-list
            data-settled-turn-count={visibleTurns.length}
            className="relative w-full list-none"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = listRows[virtualItem.index];
              if (!row) return null;
              return (
                <li
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  data-chat-turn-row={
                    row.kind === "queued-controls" ? "queued-controls" : "settled"
                  }
                  data-chat-turn-role={row.kind === "queued-controls" ? undefined : row.turn.role}
                  data-chat-turn-continues={continuing[virtualItem.index] ? "" : undefined}
                  data-chat-turn-inherited={
                    row.kind !== "queued-controls" && row.inherited ? "" : undefined
                  }
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {renderRow(row, virtualItem.index)}
                </li>
              );
            })}
          </ol>
        </ChatColumn>
      </div>

      <JumpToLatestButton
        hidden={mode === "follow"}
        bottomInset={bottomInset}
        // Instant jump: mode flips to follow synchronously inside enterFollow, so
        // the pill hides the same frame the viewport lands at the live edge.
        onClick={enterFollow}
      />
    </div>
  );
}

/** Latest transcript location for a child: its finished line, else its launch card. */
export function resolveSubagentRevealTurnId(
  turns: Turn[],
  childThreadId: string,
  originTurnId: string,
): string {
  return buildTranscriptModel(turns, false).resolveRevealTurnId(childThreadId, originTurnId);
}

function JumpToLatestButton({
  hidden,
  bottomInset,
  onClick,
}: {
  hidden: boolean;
  bottomInset: number;
  onClick: () => void;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex justify-center transition-[opacity,translate] duration-200 data-[hidden=true]:translate-y-full data-[hidden=true]:opacity-0"
      data-hidden={hidden}
      // `inert` makes the faded-out pill genuinely gone — unclickable, unfocusable,
      // and out of the accessibility tree — while CSS keeps animating the exit.
      // Without it the invisible button would still be an enabled hit target.
      inert={hidden}
      style={{ bottom: bottomInset + 12 }}
    >
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        onClick={onClick}
        className="pointer-events-auto rounded-full border border-border shadow-button"
      >
        <ArrowDownIcon />
        <span className="sr-only">Scroll to latest</span>
      </Button>
    </div>
  );
}

/** One inherited row: its source's header when a run starts, the fork point when it ends. */
function InheritedRow({
  mark,
  owners,
  children,
}: {
  mark: InheritedMark;
  owners: InheritedView["owners"] | null;
  children: ReactNode;
}) {
  return (
    <div data-inherited-row>
      {mark.startsOwner ? (
        <InheritedSourceHeader
          ownerThreadId={mark.ownerThreadId}
          owner={owners?.get(mark.ownerThreadId) ?? null}
        />
      ) : null}
      {children}
      {mark.endsInherited ? <ForkPointRule /> : null}
    </div>
  );
}

function isActiveControl(control: QueuedControl): boolean {
  return (
    control.status === "queued" ||
    control.status === "failed" ||
    control.status === "withdrawing" ||
    control.status === "withdraw_failed"
  );
}

function isSettledControl(control: QueuedControl): boolean {
  return (
    control.status === "withdrawn" ||
    control.status === "stopping" ||
    control.status === "already_finished"
  );
}

/** Index of the last assistant turn in `turns`, or -1 if none. */
function findLastAssistantIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn?.role === "assistant" && isTerminalTurnStatus(turn.status)) return i;
  }
  return -1;
}
