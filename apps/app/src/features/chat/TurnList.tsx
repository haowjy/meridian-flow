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
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { UserTurnRecovery } from "@/client/chat-submissions/presentation";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { IconButton } from "@/components/ui/icon-button";
import { AssistantTurn } from "./AssistantTurn";
import { ChatColumn } from "./ChatColumn";
import { useChatSurfaceBottomInset } from "./ChatSurface";
import { readChatViewRecord, writeChatViewRecord } from "./chat-view-record";
import { CompactionDivider } from "./compaction/CompactionDivider";
import { HandoffBriefCard } from "./derivation/HandoffBriefCard";
import { ForkPointRule, InheritedSourceHeader } from "./derivation/InheritedMarks";
import type { InheritedView } from "./derivation/inherited-view";
import { ThreadReferenceChip } from "./derivation/ThreadReferenceChip";
import type { HandoffBrief } from "./derivation/useHandoffBrief";
import { DeliveryEventRows } from "./subagent/DeliveryEventRows";
import { QueuedControlRows } from "./thread-controls/QueuedControlRows";
import type { QueuedControl } from "./thread-controls/thread-controls";
import type { ThreadControls } from "./thread-controls/useThreadControls";
import { AppliedWriteModeNotice } from "./thread-controls/WriteModeNotice";
import { TurnCardDraftsProvider } from "./turn-card-drafts";
import { UserTurn } from "./UserTurn";
import { useChatFollowScroll } from "./useChatFollowScroll";
import type { ChatStop } from "./useChatStop";
import { useTurnRevealLanding } from "./useTurnRevealLanding";

export type TurnQueueControls = {
  remove: (turnId: string) => void;
  cancelQueue: () => void;
  sendNow: { available: boolean; busy: boolean; send: () => void };
};

export type TurnListProps = {
  threadId: string;
  view: TranscriptView;
  historySettled: boolean;
  tailFollowRevision: number;
  ariaLabel: string;
  submissionRecoveryByTurnId?: ReadonlyMap<string, UserTurnRecovery>;
  controls?: ThreadControls | null;
  chatStop?: ChatStop | null;
  queue?: TurnQueueControls | null;
  brief?: HandoffBrief | null;
  onEditStopped?: ((turnId: string) => void) | null;
  isStandIn?: ((turnId: string) => boolean) | null;
  busy?: boolean;
  inherited?: InheritedView | null;
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

type ListRow =
  | ViewRow
  | { kind: "inherited-failed" }
  | { kind: "queued-controls"; key: string; controls: readonly QueuedControl[] };

const QUEUED_CONTROLS_KEY = "queued-controls";
const SWITCHES_BEFORE_REPLY_KEY = "queued-controls-before-reply";
const INHERITED_FAILED_KEY = "inherited-failed";
const NO_CONTROLS: readonly QueuedControl[] = [];

const ESTIMATED_TURN_HEIGHT = 160;
const TOP_INSET = 24;

export function TurnList({
  threadId,
  view,
  historySettled,
  tailFollowRevision,
  ariaLabel,
  submissionRecoveryByTurnId,
  controls = null,
  chatStop = null,
  queue = null,
  brief = null,
  onEditStopped = null,
  isStandIn = null,
  busy = false,
  inherited = null,
  onRetryInherited = null,
  threadUsage = null,
}: TurnListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const bottomInset = useChatSurfaceBottomInset();
  const { rows } = view;
  const visibleTurns = useMemo(() => rows.map((row) => row.turn), [rows]);
  const lastAssistantIdx = findLastLocalAssistantIndex(rows);
  const stoppedMessageId = useMemo(() => findStoppedMessageId(rows), [rows]);
  const usageAssistantIdx = busy ? findLatestLocalLiveAssistantIndex(rows) : lastAssistantIdx;
  const { lastQueuedTurnId, queuedCount } = useMemo(() => {
    const queued = rows.filter((row) => row.queued);
    return { lastQueuedTurnId: queued.at(-1)?.turn.id ?? null, queuedCount: queued.length };
  }, [rows]);
  const { beforeReply, tailControls } = useMemo(() => {
    const pending = controls?.queued ?? NO_CONTROLS;
    return {
      beforeReply: pending.filter((control) => control.awaitsRun),
      tailControls: pending.filter((control) => !control.awaitsRun),
    };
  }, [controls?.queued]);
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
  const listIndexOf = useCallback(
    (rowIdx: number) => rowIdx + rowOffset + (noticeAt >= 0 && rowIdx >= controlSlot ? 1 : 0),
    [rowOffset, noticeAt, controlSlot],
  );
  const rowIndexOf = useCallback(
    (listIdx: number) => listIdx - rowOffset - (noticeAt >= 0 && listIdx > noticeAt ? 1 : 0),
    [rowOffset, noticeAt],
  );
  const [restored] = useState(() => readChatViewRecord(threadId));
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
    paddingEnd: bottomInset,
    initialMeasurementsCache: restored?.measurements,
    initialOffset: restored?.offset,
  });

  // ShouldAdjustScrollPositionOnItemSizeChange is an instance property in virtual-core@3.17 (an options-object value is silently ignored); use item.end, not item.start, or a straddling row silently re-captures follow.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item: VirtualItem) =>
    item.end <= (viewportRef.current?.scrollTop ?? 0);

  const { mode, currentMode, enterFollow, releaseFollow } = useChatFollowScroll({
    scrollRef: viewportRef,
    contentHeight: virtualizer.getTotalSize(),
    initialMode: restored?.mode,
  });

  useLayoutEffect(
    () => () => {
      const measurements = virtualizer.takeSnapshot();
      if (measurements.length === 0) return;
      writeChatViewRecord(threadId, {
        measurements,
        offset: virtualizer.scrollOffset ?? 0,
        mode: currentMode(),
      });
    },
    [currentMode, threadId, virtualizer],
  );

  useTurnRevealLanding({
    threadId,
    turns: visibleTurns,
    resolveTurnId: (turnId, subagentThreadId, subagentBlock) =>
      subagentThreadId && subagentBlock !== "card"
        ? (view.revealTurnByChildThreadId.get(subagentThreadId) ?? turnId)
        : turnId,
    historySettled,
    viewportRef,
    scrollToIndex: (index) => {
      releaseFollow();
      virtualizer.scrollToIndex(listIndexOf(index), { align: "center" });
    },
  });

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
            onWithdraw={
              withdraw
                ? (control) => {
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
          submissionRecovery={local ? submissionRecoveryByTurnId?.get(row.turn.id) : undefined}
          queue={queuedWriter ? queue : null}
          lastQueued={queuedWriter && row.turn.id === lastQueuedTurnId}
          onEdit={row.turn.id === stoppedMessageId ? onEditStopped : null}
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
      chatStop,
      controls,
      inherited?.owners,
      isStandIn,
      lastAssistantIdx,
      lastQueuedTurnId,
      onEditStopped,
      onRetryInherited,
      queue,
      queuedCount,
      rowIndexOf,
      stoppedMessageId,
      submissionRecoveryByTurnId,
      threadId,
      threadUsage,
      view.items,
      view.writer,
    ],
  );

  return (
    <div className="focus-ring-frame relative flex min-h-0 flex-1 flex-col">
      <div
        ref={viewportRef}
        role="log"
        aria-label={ariaLabel}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: transcript is a scroll region — focusable so keyboard users can scroll it (arrows/PageUp/Down).
        tabIndex={0}
        data-ring-on-frame=""
        className="chat-scroll-fade-bottom outline-none size-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none]"
      >
        <ChatColumn>
          <TurnCardDraftsProvider threadId={threadId}>
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
          </TurnCardDraftsProvider>
        </ChatColumn>
      </div>

      <JumpToLatestButton
        hidden={mode === "follow"}
        bottomInset={bottomInset}
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
      className="pointer-events-none absolute inset-x-0 flex justify-center transition-[opacity,translate] data-[hidden=true]:translate-y-full data-[hidden=true]:opacity-0"
      data-hidden={hidden}
      inert={hidden}
      style={{ bottom: bottomInset + 12 }}
    >
      <IconButton
        type="button"
        variant="secondary"
        size="sm"
        label={t`Scroll to latest`}
        onClick={onClick}
        className="pointer-events-auto rounded-full border border-border"
      >
        <ArrowDownIcon />
      </IconButton>
    </div>
  );
}

const TranscriptRow = memo(function TranscriptRow({
  row,
  items,
  writer,
  threadId,
  submissionRecovery,
  queue,
  lastQueued,
  queuedCount,
  onEdit,
  isLatestAssistant,
  standIn,
  stopping,
  onStop,
  brief,
  destinationBusy,
  owners,
  threadUsage,
}: {
  row: ViewRow;
  items?: AssistantView;
  writer?: WriterText;
  threadId: string;
  submissionRecovery?: UserTurnRecovery;
  queue?: TurnQueueControls | null;
  lastQueued: boolean;
  queuedCount: number;
  onEdit: ((turnId: string) => void) | null;
  isLatestAssistant: boolean;
  standIn: boolean;
  stopping: boolean;
  onStop?: () => void;
  brief?: HandoffBrief | null;
  destinationBusy: boolean;
  owners: InheritedView["owners"] | null;
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
  } else if (row.kind === "delivery") {
    content = <DeliveryEventRows groups={row.deliveries} />;
  } else if (writer) {
    content = (
      <UserTurn
        turn={turn}
        writer={writer}
        submissionRecovery={submissionRecovery}
        queued={row.queued}
        queueControls={queue}
        lastQueued={lastQueued}
        queuedCount={queuedCount}
        onEdit={onEdit}
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

function findStoppedMessageId(rows: readonly ViewRow[]): string | null {
  const replyAt = rows.findLastIndex((row) => row.kind === "turn" && row.turn.role === "assistant");
  const reply = rows[replyAt];
  if (!reply || reply.inherited || reply.turn.status !== "cancelled" || reply.movedPast)
    return null;
  for (let i = replyAt - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.inherited) return null;
    if (row.kind === "turn" && row.turn.role === "user" && row.turn.origin === "writer")
      return row.queued ? null : row.turn.id;
  }
  return null;
}

function findLastLocalAssistantIndex(rows: readonly ViewRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.inherited) continue;
    if (row.turn.role === "assistant" && isTerminalTurnStatus(row.turn.status)) return i;
  }
  return -1;
}

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
