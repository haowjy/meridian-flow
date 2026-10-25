/** Renders the transcript and owns its scroll viewport. */

import { t } from "@lingui/core/macro";
import { isTerminalTurnStatus } from "@meridian/contracts/protocol";
import type {
  AssistantView,
  InheritedMark,
  TranscriptView,
  ViewRow,
  WriterText,
} from "@meridian/thread-client";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import type { ChangeTrailShell } from "@/client/change-trails";
import type { UserTurnRecovery } from "@/client/chat-submissions/presentation";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { AssistantTurn } from "./AssistantTurn";
import { ChatColumn } from "./ChatColumn";
import { useChatSurfaceBottomInset } from "./ChatSurface";
import { CompactionDivider } from "./compaction/CompactionDivider";
import { HandoffBriefCard } from "./derivation/HandoffBriefCard";
import { ForkPointRule, InheritedSourceHeader } from "./derivation/InheritedMarks";
import type { InheritedView } from "./derivation/inherited-view";
import { ThreadReferenceChip } from "./derivation/ThreadReferenceChip";
import type { HandoffBrief } from "./derivation/useHandoffBrief";
import { QueuedControlRows } from "./thread-controls/QueuedControlRows";
import type { QueuedControl } from "./thread-controls/thread-controls";
import type { ThreadControls } from "./thread-controls/useThreadControls";
import { AppliedWriteModeNotice } from "./thread-controls/WriteModeNotice";
import { UserTurn } from "./UserTurn";
import { useChangeTrailNavigation } from "./useChangeTrailNavigation";
import { useChatFollowScroll } from "./useChatFollowScroll";
import type { ChatStop } from "./useChatStop";
import { useTurnRevealLanding } from "./useTurnRevealLanding";

/** What the queued rows can do; the hooks behind them are `useQueueControls` and `useSendNow`. */
export type TurnQueueControls = {
  /** The x on a queued row. */
  remove: (turnId: string) => void;
  cancelQueue: () => void;
  sendNow: { available: boolean; busy: boolean; send: () => void };
};

export type TurnListProps = {
  threadId: string;
  /** The chat's handle once it is named: a just-sent upload link follows before the stored text is reloaded. */
  uploadsChat?: string;
  /** What the transcript shows, decided by `viewTranscript`: rows, items and writer text. */
  view: TranscriptView;
  historySettled: boolean;
  /** Monotonic submit signal: new local messages intentionally reacquire tail-follow. */
  tailFollowRevision: number;
  /** Accessible label for the scroll log region. */
  ariaLabel: string;
  changeTrails?: Record<string, ChangeTrailShell>;
  /** Recovered failed submissions, keyed by the restored user turn id. */
  submissionRecoveryByTurnId?: ReadonlyMap<string, UserTurnRecovery>;
  /** Writer commands: queued `/compact` and switches with their Stop, and Stop on a running divider. */
  controls?: ThreadControls | null;
  /** The chat's Stop: a compaction divider's Stop is this one, not a turn cancel. */
  chatStop?: ChatStop | null;
  /** The queued rows' x, Cancel queue and Send now. */
  queue?: TurnQueueControls | null;
  /** Retry and Stop on this handoff destination's brief cards. */
  brief?: HandoffBrief | null;
  /** Whether a reply is a Retry's stand-in the server doesn't have yet: nothing to read or act on. */
  isStandIn?: ((turnId: string) => boolean) | null;
  /** Something holds this chat (a reply, a compaction, a brief): a brief card's Retry waits. */
  busy?: boolean;
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
 * A virtual row: a transcript row, the missing-history alert above them, or the
 * queued commands at the tail.
 */
type ListRow =
  | ViewRow
  | { kind: "inherited-failed" }
  | { kind: "queued-controls"; key: string; controls: readonly QueuedControl[] };

const QUEUED_CONTROLS_KEY = "queued-controls";
const SWITCHES_BEFORE_REPLY_KEY = "queued-controls-before-reply";
const INHERITED_FAILED_KEY = "inherited-failed";
const NO_CONTROLS: readonly QueuedControl[] = [];

/** Estimated row height before measurement; corrected by `measureElement`. */
const ESTIMATED_TURN_HEIGHT = 160;
/** Top breathing room above the first turn (virtual paddingStart, px). */
const TOP_INSET = 24;

export function TurnList({
  threadId,
  uploadsChat,
  view,
  historySettled,
  tailFollowRevision,
  ariaLabel,
  changeTrails = {},
  submissionRecoveryByTurnId,
  controls = null,
  chatStop = null,
  queue = null,
  brief = null,
  isStandIn = null,
  busy = false,
  inherited = null,
  onRetryInherited = null,
  threadUsage = null,
}: TurnListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const navigateToChange = useChangeTrailNavigation(threadId);
  const bottomInset = useChatSurfaceBottomInset();
  const { rows } = view;
  const visibleTurns = useMemo(() => rows.map((row) => row.turn), [rows]);
  const lastAssistantIdx = findLastLocalAssistantIndex(rows);
  // While a run is active, usage belongs to that live row. Once it settles,
  // keep the final aggregate on the latest settled action row. This avoids
  // moving the snapshot through historical model-step rows at each boundary.
  const usageAssistantIdx = busy ? findLatestLocalLiveAssistantIndex(rows) : lastAssistantIdx;
  // Cancel queue and Send now sit on the last queued row; Cancel queue needs two to differ from the x.
  const { lastQueuedTurnId, queuedCount } = useMemo(() => {
    const queued = rows.filter((row) => row.queued);
    return { lastQueuedTurnId: queued.at(-1)?.turn.id ?? null, queuedCount: queued.length };
  }, [rows]);
  // A command runs only when no message waits, so queued commands sit at the
  // tail, after every queued message: they take no position until they run. A switch the
  // record says applies at the next run's start is the exception: its turn lands before that
  // run's reply, so its notice sits where `viewTranscript` puts the slot.
  const { beforeReply, tailControls } = useMemo(() => {
    const pending = controls?.queued ?? NO_CONTROLS;
    return {
      beforeReply: pending.filter((control) => control.awaitsRun),
      tailControls: pending.filter((control) => !control.awaitsRun),
    };
  }, [controls?.queued]);
  // List rows are transcript rows shifted down by the alert, when it shows, and by the notice
  // that sits among them.
  const rowOffset = onRetryInherited ? 1 : 0;
  const { controlSlot } = view;
  const noticeAt = beforeReply.length ? rowOffset + controlSlot : -1;
  const listRows = useMemo<ListRow[]>(
    () => [
      ...(onRetryInherited ? [{ kind: "inherited-failed" as const }] : []),
      ...rows.slice(0, controlSlot),
      ...(beforeReply.length
        ? [
            {
              kind: "queued-controls" as const,
              key: SWITCHES_BEFORE_REPLY_KEY,
              controls: beforeReply,
            },
          ]
        : []),
      ...rows.slice(controlSlot),
      ...(tailControls.length
        ? [{ kind: "queued-controls" as const, key: QUEUED_CONTROLS_KEY, controls: tailControls }]
        : []),
    ],
    [onRetryInherited, beforeReply, tailControls, rows, controlSlot],
  );
  /** A transcript row's place in the list, and back. */
  const listIndexOf = useCallback(
    (rowIdx: number) => rowIdx + rowOffset + (noticeAt >= 0 && rowIdx >= controlSlot ? 1 : 0),
    [rowOffset, noticeAt, controlSlot],
  );
  const rowIndexOf = useCallback(
    (listIdx: number) => listIdx - rowOffset - (noticeAt >= 0 && listIdx > noticeAt ? 1 : 0),
    [rowOffset, noticeAt],
  );
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
      return row.kind === "queued-controls" ? row.key : row.renderKey;
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

  // Follow policy. `getTotalSize()` is the content height AND the revision: it is
  // the height the virtualized list scrolls over, and it changes on turn append,
  // on measured streaming-row growth, and on composer-inset change — each change
  // re-renders this component, so the follow pin fires before paint. Passing the
  // height (not a bare counter) lets the pin compute the bottom without reading
  // `scrollHeight`, which would force a layout on every revision.
  // The thread opens in `follow`, so the very first pin anchors to the newest turn.
  const { mode, enterFollow, releaseFollow } = useChatFollowScroll({
    scrollRef: viewportRef,
    contentHeight: virtualizer.getTotalSize(),
  });

  // Turn stage of a conversation reveal. The transcript owns the landing (and
  // the verdict when the turn isn't here); the scroll capability stays here.
  useTurnRevealLanding({
    threadId,
    turns: visibleTurns,
    // The launch card lives in the origin turn; only "latest" follows the child forward.
    resolveTurnId: (turnId, subagentThreadId, subagentBlock) =>
      subagentThreadId && subagentBlock !== "card"
        ? (view.revealTurnByChildThreadId.get(subagentThreadId) ?? turnId)
        : turnId,
    historySettled,
    viewportRef,
    scrollToIndex: (index) => {
      // A transcript that has just mounted is still following the live edge,
      // and would pin back to the bottom once the target's rows are measured.
      releaseFollow();
      virtualizer.scrollToIndex(listIndexOf(index), { align: "center" });
    },
  });

  // Reacquire follow when the user submits (each local message bumps the revision).
  useEffect(() => {
    if (tailFollowRevision === 0) return;
    enterFollow();
  }, [tailFollowRevision, enterFollow]);

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
            onStop={
              withdraw
                ? (control) => {
                    // Stop removes the row at once. The last one takes the
                    // whole tail with it, so keep focus in the transcript.
                    if (row.controls.length === 1)
                      viewportRef.current?.focus({ preventScroll: true });
                    withdraw(control);
                  }
                : undefined
            }
          />
        );
      }
      const rowIndex = rowIndexOf(idx);
      const local = !row.inherited;
      const writer = view.writer.get(row.turn.id);
      const items = view.items.get(row.turn.id);
      const queuedWriter = Boolean(writer && row.queued && local);
      const compaction = row.kind === "compaction" && local;
      const handoff = row.kind === "handoff-seed" && local;
      const assistant = Boolean(items && row.response);
      return (
        <TranscriptRow
          row={row}
          items={items}
          writer={writer}
          threadId={threadId}
          uploadsChat={local ? uploadsChat : undefined}
          submissionRecovery={local ? submissionRecoveryByTurnId?.get(row.turn.id) : undefined}
          queue={queuedWriter ? queue : null}
          lastQueued={queuedWriter && row.turn.id === lastQueuedTurnId}
          queuedCount={queuedWriter ? queuedCount : 0}
          isLatestAssistant={rowIndex === lastAssistantIdx}
          standIn={local && (isStandIn?.(row.turn.id) ?? false)}
          stopping={
            compaction && (chatStop?.status === "pending" || chatStop?.status === "stopping")
          }
          onStop={compaction ? chatStop?.stop : undefined}
          brief={handoff ? brief : null}
          destinationBusy={handoff && busy}
          owners={row.inherited ? (inherited?.owners ?? null) : null}
          changeTrail={assistant && local ? byTurnId.get(row.turn.id) : undefined}
          navigateToChange={assistant ? navigateToChange : undefined}
          // Thread cache stats follow the active run, or the latest settled
          // action row once no assistant row is live. Passing the snapshot to
          // every historical model-step row defeats the row memo boundary.
          threadUsage={
            assistant && local && usageAssistantIdx !== null && rowIndex === usageAssistantIdx
              ? threadUsage
              : null
          }
        />
      );
    },
    [
      brief,
      busy,
      byTurnId,
      chatStop,
      controls,
      inherited?.owners,
      isStandIn,
      lastAssistantIdx,
      lastQueuedTurnId,
      navigateToChange,
      onRetryInherited,
      queue,
      queuedCount,
      rowIndexOf,
      submissionRecoveryByTurnId,
      threadId,
      threadUsage,
      uploadsChat,
      view.items,
      view.writer,
    ],
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
                  // Compaction and handoff-seed rows draw no turn of their own; the id lets a comparison match them.
                  data-turn-id={
                    transcriptRow && (row.kind === "compaction" || row.kind === "handoff-seed")
                      ? transcriptRow.turn.id
                      : undefined
                  }
                  data-chat-turn-continues={transcriptRow?.continuing ? "" : undefined}
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

const TranscriptRow = memo(function TranscriptRow({
  row,
  items,
  writer,
  threadId,
  uploadsChat,
  submissionRecovery,
  queue,
  lastQueued,
  queuedCount,
  isLatestAssistant,
  standIn,
  stopping,
  onStop,
  brief,
  destinationBusy,
  owners,
  changeTrail,
  navigateToChange,
  threadUsage,
}: {
  row: ViewRow;
  items?: AssistantView;
  writer?: WriterText;
  threadId: string;
  uploadsChat?: string;
  submissionRecovery?: UserTurnRecovery;
  queue?: TurnQueueControls | null;
  lastQueued: boolean;
  queuedCount: number;
  isLatestAssistant: boolean;
  standIn: boolean;
  stopping: boolean;
  onStop?: () => void;
  brief?: HandoffBrief | null;
  destinationBusy: boolean;
  owners: InheritedView["owners"] | null;
  changeTrail?: ChangeTrailShell;
  navigateToChange?: ReturnType<typeof useChangeTrailNavigation>;
  threadUsage: TurnListProps["threadUsage"];
}) {
  const { turn } = row;
  let content: ReactNode;
  if (row.kind === "compaction") {
    content = <CompactionDivider turn={turn} stopping={stopping} onStop={onStop} />;
  } else if (row.kind === "write-mode") {
    content = <AppliedWriteModeNotice turn={turn} />;
  } else if (row.kind === "thread-reference") {
    content = (
      <div data-thread-references className="flex flex-wrap gap-[var(--chat-space-inline)]">
        {row.references.map((reference) => (
          <ThreadReferenceChip key={reference.threadId} reference={reference} />
        ))}
      </div>
    );
  } else if (row.kind === "handoff-seed") {
    content = (
      <HandoffBriefCard
        turn={turn}
        latest={row.latest}
        stopping={brief?.stopping.has(turn.id) ?? false}
        destinationBusy={destinationBusy}
        onStop={brief?.canStop(turn) ? brief.stop : undefined}
        onRetry={brief?.retry}
      />
    );
  } else if (writer) {
    content = (
      <UserTurn
        turn={turn}
        writer={writer}
        uploadsChat={uploadsChat}
        submissionRecovery={submissionRecovery}
        queued={row.queued}
        queueControls={queue}
        lastQueued={lastQueued}
        queuedCount={queuedCount}
      />
    );
  } else if (items && row.response) {
    content = (
      <AssistantTurn
        threadId={row.inherited?.ownerThreadId ?? threadId}
        turn={turn}
        view={items}
        response={row.response}
        threadUsage={threadUsage}
        deliveries={row.deliveries}
        isLatestAssistant={isLatestAssistant}
        movedPast={row.movedPast}
        continuesResponse={row.continuing}
        standIn={standIn}
        changeTrail={changeTrail}
        navigateToChange={navigateToChange}
      />
    );
  } else {
    content = null;
  }

  return row.inherited ? (
    <InheritedRow mark={row.inherited} owners={owners}>
      {content}
    </InheritedRow>
  ) : (
    content
  );
});

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
function findLastLocalAssistantIndex(rows: readonly ViewRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.inherited) continue;
    if (row.turn.role === "assistant" && isTerminalTurnStatus(row.turn.status)) return i;
  }
  return -1;
}

/** Index of the latest local assistant still running, if any. */
function findLatestLocalLiveAssistantIndex(rows: readonly ViewRow[]): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (
      row &&
      !row.inherited &&
      row.turn.role === "assistant" &&
      !isTerminalTurnStatus(row.turn.status)
    )
      return i;
  }
  return null;
}
