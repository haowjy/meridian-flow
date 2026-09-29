/** Renders the transcript and owns its scroll viewport. */

import { t } from "@lingui/core/macro";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/protocol";
import type { ThreadPhase } from "@meridian/contracts/threads";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import type { ChangeTrailShell } from "@/client/change-trails";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { AssistantTurn } from "./AssistantTurn";
import { ChatColumn } from "./ChatColumn";
import { useChatSurfaceBottomInset } from "./ChatSurface";
import type { InterruptRespondRequest } from "./CustomBlockRenderer";
import { CompactionDivider } from "./compaction/CompactionDivider";
import { answeredControlIds } from "./compaction/compaction-model";
import { QueuedControlRows } from "./compaction/QueuedControlRows";
import { placeQueuedControls, type QueuedControl } from "./compaction/thread-controls";
import type { ThreadControls } from "./compaction/useThreadControls";
import { HandoffBriefCard } from "./derivation/HandoffBriefCard";
import { ForkPointRule, InheritedSourceHeader } from "./derivation/InheritedMarks";
import type { InheritedView } from "./derivation/inherited-view";
import { ThreadReferenceChip } from "./derivation/ThreadReferenceChip";
import type { HandoffBrief } from "./derivation/useHandoffBrief";
import { unreadWriterTurnIds } from "./pending-inbox";
import { buildTranscriptModel, type InheritedMark, type TranscriptRow } from "./transcript-model";
import type { ReplyRetry } from "./useReplyRetry";

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
  /** Writer commands: queued `/compact`, withdrawal, and Stop on a running divider. */
  controls?: ThreadControls | null;
  /** Retry and Stop on this handoff destination's brief cards. */
  brief?: HandoffBrief | null;
  /** Retry on the latest failed reply, and the new replies it stands in for. */
  replyRetry?: ReplyRetry | null;
  /** Something holds this chat (a reply, a compaction, a brief): Retry waits. */
  busy?: boolean;
  /** The live lease phase while the thread is awake. */
  phase?: ThreadPhase | null;
  /** A fork's frozen prefix from its source, rendered read-only above its own turns. */
  inherited?: InheritedView | null;
  /** The fork's inherited read failed: its history is missing, so say so where it would start. */
  onRetryInherited?: (() => void) | null;
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

/**
 * A virtual row: a transcript row, the missing-history alert above them, or
 * queued commands at their place in the queue.
 */
type ListRow =
  | TranscriptRow
  | { kind: "inherited-failed" }
  | { kind: "queued-controls"; key: string; controls: readonly QueuedControl[] };

const INHERITED_FAILED_KEY = "inherited-failed";
const NO_CONTROLS: readonly QueuedControl[] = [];
const NO_QUEUED_TURNS: ReadonlySet<string> = new Set();

/** The virtual list's rows, with the transcript index each list row renders. */
function buildListRows(input: {
  rows: readonly TranscriptRow[];
  inheritedFailed: boolean;
  controls: ReadonlyMap<number, readonly QueuedControl[]>;
}): { listRows: ListRow[]; transcriptIndex: (number | null)[]; listIndex: number[] } {
  const listRows: ListRow[] = [];
  const transcriptIndex: (number | null)[] = [];
  const listIndex: number[] = [];
  const pushControls = (index: number) => {
    const controls = input.controls.get(index);
    if (!controls?.length) return;
    // Keyed by the slot, not a command: withdrawing one keeps the row mounted.
    const before = input.rows[index]?.turn.id ?? "end";
    listRows.push({ kind: "queued-controls", key: `queued-before:${before}`, controls });
    transcriptIndex.push(null);
  };
  if (input.inheritedFailed) {
    listRows.push({ kind: "inherited-failed" });
    transcriptIndex.push(null);
  }
  input.rows.forEach((row, index) => {
    pushControls(index);
    listIndex.push(listRows.length);
    listRows.push(row);
    transcriptIndex.push(index);
  });
  pushControls(input.rows.length);
  return { listRows, transcriptIndex, listIndex };
}

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
  brief = null,
  replyRetry = null,
  busy = false,
  phase = null,
  inherited = null,
  onRetryInherited = null,
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
  const lastAssistantIdx = findLastLocalAssistantIndex(transcript.rows);
  // Queued commands wait among the queued messages in the order they were
  // sent; they take a transcript position of their own only when they run.
  const placedControls = useMemo(() => {
    const answered = answeredControlIds(turns);
    return placeQueuedControls({
      controls: (controls?.queued ?? NO_CONTROLS).filter((control) => !answered.has(control.id)),
      rowTurnIds: transcript.rows.map((row) => (row.inherited ? null : row.turn.id)),
      queuedTurnIds: unreadWriterTurnIds(turns, queuedWriterTurnIds ?? NO_QUEUED_TURNS),
    });
  }, [controls?.queued, queuedWriterTurnIds, transcript.rows, turns]);
  const { listRows, transcriptIndex, listIndex } = useMemo(
    () =>
      buildListRows({
        rows: transcript.rows,
        inheritedFailed: onRetryInherited !== null,
        controls: placedControls,
      }),
    [onRetryInherited, placedControls, transcript.rows],
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
      if (row.kind === "inherited-failed") return INHERITED_FAILED_KEY;
      return row.kind === "queued-controls" ? row.key : row.turn.id;
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
    scrollToIndex: (index) =>
      virtualizer.scrollToIndex(listIndex[index] ?? index, { align: "center" }),
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
            phase={local ? phase : null}
            stopping={local && (controls?.stoppingTurnIds.has(turn.id) ?? false)}
            onStop={local ? controls?.stop : undefined}
          />
        );
      }
      if (row.kind === "thread-reference") {
        return (
          <div data-thread-references className="flex flex-wrap gap-[var(--chat-space-inline)]">
            {row.references.map((reference) => (
              <ThreadReferenceChip key={reference.threadId} reference={reference} />
            ))}
          </div>
        );
      }
      if (row.kind === "handoff-seed") {
        const actions = local ? brief : null;
        return (
          <HandoffBriefCard
            turn={turn}
            latest={row.latest}
            stopping={actions?.stopping.has(turn.id) ?? false}
            stopFailed={actions?.stopFailed.has(turn.id) ?? false}
            retryRefused={actions?.retryRefused.has(turn.id) ?? false}
            destinationBusy={busy}
            onStop={actions?.canStop(turn) ? actions.stop : undefined}
            onRetry={actions?.retry}
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
      // A divider is a row: once one follows a failed reply, that failure is
      // history. A queued command is not a transcript row and never counts. An
      // inherited reply is the source's history, even with nothing below it.
      const endsTranscript = local && idx === visibleTurns.length - 1;
      const sendRetry =
        local && turn.id === failedSendRetry?.turnId ? failedSendRetry.retry : undefined;
      const standIn = local ? (replyRetry?.requestOf(turn.id) ?? null) : null;
      const retry =
        local && replyRetry && turn.status === "error" && !sendRetry
          ? {
              // Only the latest turn can be retried: the server answers its
              // messages again below it.
              onRetry: endsTranscript
                ? () => {
                    // Retry leaves with this row's error; keep focus in the
                    // transcript and bring the new reply into view.
                    viewportRef.current?.focus({ preventScroll: true });
                    enterFollow();
                    replyRetry.retry(turn);
                  }
                : undefined,
              waiting: busy,
              refused: replyRetry.refused.has(turn.id),
              requestLost: standIn === "failed",
            }
          : undefined;
      return (
        <AssistantTurn
          threadId={row.inherited?.ownerThreadId ?? threadId}
          turn={turn}
          responseParts={partsByFinalTurnId.get(turn.id)}
          threadUsage={local ? threadUsage : null}
          deliveryEvents={transcript.deliveryEventsFor(turn.id)}
          isLatestAssistant={idx === lastAssistantIdx}
          endsTranscript={endsTranscript}
          continuesResponse={continuing[idx] ?? false}
          failedSendRetry={sendRetry}
          replyRetry={retry}
          standIn={standIn !== null}
          onRespondToInterrupt={local ? onRespondToInterrupt : undefined}
          changeTrail={local ? byTurnId.get(turn.id) : undefined}
          navigateToChange={navigateToChange}
        />
      );
    },
    [
      brief,
      busy,
      byTurnId,
      enterFollow,
      replyRetry,
      controls,
      phase,
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
      if (row.kind === "inherited-failed") {
        return (
          <div data-inherited-failed className="pb-[var(--chat-space-turn)]">
            <InlineErrorRow
              message={t`Couldn't load the conversation this fork continues.`}
              onRetry={onRetryInherited ?? undefined}
            />
          </div>
        );
      }
      if (row.kind === "queued-controls") {
        const withdraw = controls?.withdraw;
        return (
          <QueuedControlRows
            controls={row.controls}
            onWithdraw={
              withdraw
                ? (control) => {
                    // Withdraw removes the row at once. The last one here takes
                    // the whole list row with it, so keep focus in the transcript.
                    if (row.controls.length === 1)
                      viewportRef.current?.focus({ preventScroll: true });
                    withdraw(control);
                  }
                : undefined
            }
            onRetry={controls?.retry}
          />
        );
      }
      const content = renderTranscriptRow(row, transcriptIndex[idx] ?? idx);
      return row.inherited ? (
        <InheritedRow mark={row.inherited} owners={inherited?.owners ?? null}>
          {content}
        </InheritedRow>
      ) : (
        content
      );
    },
    [controls, inherited?.owners, onRetryInherited, renderTranscriptRow, transcriptIndex],
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
              const transcriptRow =
                row.kind === "queued-controls" || row.kind === "inherited-failed" ? null : row;
              return (
                <li
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  data-chat-turn-row={transcriptRow ? "settled" : row.kind}
                  data-chat-turn-role={transcriptRow?.turn.role}
                  data-chat-turn-kind={row.kind}
                  data-chat-turn-continues={
                    continuing[transcriptIndex[virtualItem.index] ?? -1] ? "" : undefined
                  }
                  data-chat-turn-inherited={transcriptRow?.inherited ? "" : undefined}
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

/** Index of this thread's own last settled assistant turn, or -1 if none; inherited rows never count. */
function findLastLocalAssistantIndex(rows: readonly TranscriptRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.inherited) continue;
    if (row.turn.role === "assistant" && isTerminalTurnStatus(row.turn.status)) return i;
  }
  return -1;
}
