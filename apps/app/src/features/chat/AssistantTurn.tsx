/** AssistantTurn — single render path for assistant turns. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  type Block,
  blockContentRecord,
  isTerminalTurnStatus,
  type Turn,
} from "@meridian/contracts/protocol";
import { ChevronDown, ExternalLink, MessageSquareText } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { ChangeTrailShell } from "@/client/change-trails";
import { useTurnLiveLineage } from "@/client/query/useTurnLiveLineage";
import { cn } from "@/lib/utils";
import { ImageBlock } from "@/rich-content/ImageBlock";
import { Markdown } from "@/rich-content/Markdown";
import { ActivityRow } from "./ActivityRow";
import { AssistantTurnActions } from "./AssistantTurnActions";
import { assistantTurnCopyMarkdown } from "./assistant-turn-copy";
import { imageContentForBlock, isImageBlock } from "./block-kind";
import { blockRenderKey } from "./block-render-key";
import { useOpenChatThread } from "./ChatThreadNavigation";
import { CustomBlockRenderer, type InterruptRespondRequest } from "./CustomBlockRenderer";
import { ErrorBlock } from "./ErrorBlock";
import { groupDeliverySegments } from "./group-delivery-segments";
import { type DirectInvocationResult, directResultsForTurn } from "./invocation-direct-result";
import { ProcessDisclosure } from "./ProcessDisclosure";
import {
  hasVisibleReasoningText,
  lastProcessIndex,
  partitionTurn,
  type RenderItem,
  type Run,
} from "./partition-turn";
import { ReportContent } from "./ReportContent";
import { payloadText } from "./report-payload";
import { StreamingText } from "./StreamingText";
import { useSubagentActivityByRef } from "./SubagentActivityContext";
import { SubagentMark } from "./SubagentMark";
import { ToolRow } from "./ToolRow";
import { TurnBlockStep } from "./TurnBlockStep";
import { hasTurnEditsReceiptContent, TurnEditsReceipt } from "./TurnEditsReceipt";
import { thinkingDigest } from "./thinking-digest";
import { turnWorkReceipts } from "./tool-command";
import { isToolViewVisible } from "./tool-view-visibility";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";

export type AssistantTurnProps = {
  threadId?: string;
  turn: Turn;
  deliveryEvents?: Array<{ turn: Turn; childThreadId?: string; title?: string }>;
  isLatestAssistant?: boolean;
  onRetry?: () => void;
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  changeTrail?: ChangeTrailShell;
  navigateToChange?: NavigateToTrailChange;
};

function AssistantTurnComponent({
  threadId,
  turn,
  deliveryEvents = [],
  isLatestAssistant = false,
  onRetry,
  onRespondToInterrupt,
  changeTrail,
  navigateToChange,
}: AssistantTurnProps) {
  const sortedBlocks = useMemo(
    () => [...turn.blocks].sort((a, b) => a.sequence - b.sequence),
    [turn.blocks],
  );
  const isSettled = isTerminalTurnStatus(turn.status);
  const items = useMemo(() => partitionTurn(sortedBlocks), [sortedBlocks]);
  const copyMarkdown = useMemo(() => assistantTurnCopyMarkdown(items), [items]);
  const directResults = useMemo(() => directResultsForTurn(sortedBlocks), [sortedBlocks]);
  // Progressive-disclosure label: "Thinking part N" for a turn with several
  // process folds (one per artifact/interrupt-delimited stretch).
  // Ordinals count only visible folds: a process item whose runs have nothing
  // to show renders nothing, so it must not advance "Thinking part N" or the
  // total.
  const rows = useMemo(() => {
    const isVisibleFold = (item: RenderItem) =>
      item.kind === "process" && foldHasVisibleContent(item.runs);
    const processCount = items.filter(isVisibleFold).length;
    const result: { item: RenderItem; processOrdinal: number; processCount: number }[] = [];
    let processOrdinal = 0;
    for (const item of items) {
      if (isVisibleFold(item)) processOrdinal += 1;
      result.push({ item, processOrdinal, processCount });
    }
    return result;
  }, [items]);
  const finalProcessIndex = lastProcessIndex(items);
  const isErrored = turn.status === "error";
  const showsInkDrop = turn.status === "pending" || turn.status === "streaming";
  const isLive = !isSettled;
  const resolvedThreadId = threadId ?? turn.threadId;
  const liveLineage = useTurnLiveLineage(resolvedThreadId, turn.id, { enabled: !isLive });
  const liveLineageDocuments = useMemo(
    () => dedupeTurnEditDocuments(liveLineage.documents ?? []),
    [liveLineage.documents],
  );
  // Work mutations leave no document lineage; their receipts ride the turn's
  // own tool results, so a Work-mutation-only turn still gets its Undo receipt.
  // Gated on settlement like document lineage: a receipt is a record of a
  // finished turn, and mid-stream it would offer Undo on a turn still writing.
  const workReceipts = useMemo(
    () => (isLive ? [] : turnWorkReceipts(sortedBlocks)),
    [isLive, sortedBlocks],
  );

  return (
    <div
      data-assistant-turn
      data-latest-assistant={isLatestAssistant ? "true" : undefined}
      data-turn-id={turn.id}
      data-turn-role="assistant"
      data-turn-status={turn.status}
    >
      <div className="flex flex-col gap-[var(--chat-space-block)]">
        {rows.map(({ item, processOrdinal, processCount }, rowIndex) => (
          <TurnItemView
            key={itemRenderKey(item)}
            item={item}
            processOrdinal={processOrdinal}
            processCount={processCount}
            threadId={resolvedThreadId}
            turnStatus={turn.status}
            onRespondToInterrupt={onRespondToInterrupt}
            writeMode={turn.writeMode ?? "direct"}
            directResult={
              item.kind === "artifact" ? (directResults.get(item.block.id) ?? null) : null
            }
            deliveryEvents={
              item.kind === "process" && rowIndex === finalProcessIndex ? deliveryEvents : []
            }
          />
        ))}

        {rows.every(({ item }) => item.kind !== "process") ? (
          <DeliveryEventRows events={deliveryEvents} />
        ) : null}

        {hasTurnEditsReceiptContent(liveLineageDocuments, changeTrail, workReceipts) ? (
          <TurnEditsReceipt
            threadId={resolvedThreadId}
            turn={turn}
            documents={liveLineageDocuments}
            receipt={liveLineage.receipt}
            workReceipts={workReceipts}
            changeTrail={changeTrail}
            navigateToChange={navigateToChange}
          />
        ) : null}

        {isErrored ? (
          <ErrorBlock
            isLatest={isLatestAssistant}
            kind={turn.blocks.length === 0 ? "send" : "generation"}
            onRetry={isLatestAssistant ? onRetry : undefined}
          />
        ) : null}
      </div>
      {isSettled ? (
        <AssistantTurnActions threadId={resolvedThreadId} turn={turn} markdown={copyMarkdown} />
      ) : null}
      {showsInkDrop ? <InkDrop /> : null}
    </div>
  );
}

type DeliveryEvent = NonNullable<AssistantTurnProps["deliveryEvents"]>[number];

function DeliveryEventRows({ events }: { events: DeliveryEvent[] }) {
  const groups: DeliveryEvent[][] = [];
  for (const event of events) {
    const metadata = event.turn.metadata as Record<string, unknown> | null;
    const isUpdate = metadata?.kind === "subagent_update";
    const previous = groups.at(-1)?.[0]?.turn.metadata as
      | Record<string, unknown>
      | null
      | undefined;
    if (isUpdate && previous?.kind === "subagent_update") groups.at(-1)?.push(event);
    else groups.push([event]);
  }
  return (
    <>
      {groups.map((group) => {
        if (group.length > 1) {
          return (
            <MergedCompletionRow
              key={group.map((event) => event.turn.id).join(":")}
              events={group}
            />
          );
        }
        const event = group[0];
        return event ? <DeliveryEventRow key={event.turn.id} {...event} /> : null;
      })}
    </>
  );
}

function MergedCompletionRow({ events }: { events: DeliveryEvent[] }) {
  const names = events.map(({ turn }) =>
    String((turn.metadata as Record<string, unknown>).handle ?? "Subagent"),
  );
  const allSucceeded = events.every(
    ({ turn }) => (turn.metadata as Record<string, unknown>).outcome === "succeeded",
  );
  const allCancelled = events.every(
    ({ turn }) => (turn.metadata as Record<string, unknown>).outcome === "cancelled",
  );
  return (
    <details className="group min-w-0 text-sm text-muted-foreground" data-subagent-finished>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex -space-x-2">
          {names.slice(0, 3).map((name, index) => (
            <SubagentMark
              key={`${name}-${index}`}
              name={name}
              status={allSucceeded ? "done" : "stopped"}
              className="size-5 border-background text-[10px]"
            />
          ))}
        </span>
        <span className="truncate font-medium text-foreground">
          {names.length > 3 ? (
            allSucceeded ? (
              <Trans>{names.length} subagents finished</Trans>
            ) : allCancelled ? (
              <Trans>{names.length} subagents stopped</Trans>
            ) : (
              <Trans>{names.length} subagents completed</Trans>
            )
          ) : allSucceeded ? (
            <Trans>{names.join(", ")} finished</Trans>
          ) : allCancelled ? (
            <Trans>{names.join(", ")} stopped</Trans>
          ) : (
            <Trans>{names.join(", ")} completed</Trans>
          )}
        </span>
        <span className="ml-auto text-xs">+</span>
      </summary>
      <div className="ml-7 space-y-2 border-l border-border-subtle py-1 pl-3 text-xs text-muted-foreground">
        {events.map(({ turn, title }) => {
          const text = turn.blocks
            .filter((block) => block.blockType === "text")
            .map((block) => block.textContent ?? "")
            .join("");
          return (
            <div key={turn.id}>
              {title ? <p className="font-medium text-foreground">{title}</p> : null}
              {text ? <p className="whitespace-pre-wrap">{text}</p> : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function DeliveryEventRow({ turn, childThreadId, title }: DeliveryEvent) {
  const metadata =
    turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
      ? (turn.metadata as Record<string, unknown>)
      : {};
  if (metadata.kind === "subagent_update") {
    const outcome = String(metadata.outcome);
    const label =
      outcome === "succeeded" ? "finished" : outcome === "failed" ? "failed" : "stopped";
    const body = turn.blocks
      .filter((block) => block.blockType === "text")
      .map((block) => block.textContent ?? "")
      .join("");
    return (
      <details
        className="group min-w-0 text-sm text-muted-foreground"
        data-subagent-finished
        data-subagent-thread-id={childThreadId ?? undefined}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <SubagentMark
            name={String(metadata.handle)}
            status={outcome === "succeeded" ? "done" : "stopped"}
            className="size-5 text-[10px]"
          />
          <span className="truncate">
            <span className="font-medium text-foreground">{String(metadata.handle)}</span> {label}
          </span>
          <span className="ml-auto text-xs">+</span>
        </summary>
        <div className="ml-7 border-l border-border-subtle py-1 pl-3 text-xs text-muted-foreground">
          {title ? <p className="mb-1 text-foreground">{title}</p> : null}
          {body ? <p className="whitespace-pre-wrap">{body}</p> : null}
          {childThreadId ? (
            <a
              className="mt-1 inline-block rounded-sm underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={`/chat/${childThreadId}`}
            >
              <Trans>Open chat</Trans>
            </a>
          ) : null}
        </div>
      </details>
    );
  }
  const body = turn.blocks
    .filter((block) => block.blockType === "text")
    .map((block) => block.textContent ?? "")
    .join("");
  return (
    <ActivityRow Icon={MessageSquareText}>
      <span className="whitespace-pre-wrap text-foreground">{body || "Shared an attachment"}</span>
    </ActivityRow>
  );
}

function InkDrop() {
  return (
    <div className="mt-[7px] flex min-h-5 items-center" data-live-turn-ink>
      <span className="ink-drop" aria-hidden />
    </div>
  );
}

/** One entry per document, preferring its committed (`live`) lineage. */
function dedupeTurnEditDocuments<T extends { uri: string; scope: "live" | "draft" }>(
  documents: readonly T[],
): T[] {
  const byUri = new Map<string, T>();
  for (const document of documents) {
    const existing = byUri.get(document.uri);
    if (existing && (existing.scope === "live" || document.scope !== "live")) continue;
    byUri.set(document.uri, document);
  }
  return [...byUri.values()];
}

const TurnItemView = memo(function TurnItemView({
  item,
  processOrdinal,
  processCount,
  threadId,
  turnStatus,
  onRespondToInterrupt,
  writeMode,
  directResult,
  deliveryEvents,
}: {
  item: RenderItem;
  processOrdinal: number;
  processCount: number;
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  writeMode: "direct" | "draft";
  directResult: DirectInvocationResult | null;
  deliveryEvents: AssistantTurnProps["deliveryEvents"];
}) {
  const runs = item.kind === "process" ? item.runs : null;
  const digest = useMemo(
    () => (runs ? thinkingDigest(toolViewsInFold(runs), writeMode) : null),
    [runs, writeMode],
  );

  if (item.kind === "process") {
    if (!foldHasVisibleContent(item.runs)) return null;
    return (
      <div data-turn-item-kind="process">
        <ProcessDisclosure
          label={digest ?? thinkingLabel()}
          ariaLabel={thinkingAriaLabel(processOrdinal - 1, processCount)}
        >
          {item.runs.map((run) => (
            <FoldRun
              key={runRenderKey(run)}
              run={run}
              threadId={threadId}
              turnStatus={turnStatus}
              onRespondToInterrupt={onRespondToInterrupt}
              writeMode={writeMode}
            />
          ))}
        </ProcessDisclosure>
        {deliveryEvents?.length ? <DeliveryEventRows events={deliveryEvents} /> : null}
      </div>
    );
  }

  if (item.kind === "report") {
    const content = blockContentRecord(item.block);
    if (content.toolName === "thread_report") {
      return <ThreadReportArtifact refName={item.ref ?? ""} report={item.report} />;
    }
    return (
      <div
        className="space-y-[var(--chat-space-block)] text-prose-foreground"
        data-turn-item-kind="report"
      >
        <ReportContent
          report={item.report}
          empty={null}
          className="space-y-[var(--chat-space-block)]"
        />
      </div>
    );
  }

  return (
    <div className="space-y-[var(--chat-space-row)]" data-turn-item-kind={item.kind}>
      <DeliveryBlock
        block={item.block}
        threadId={threadId}
        turnStatus={turnStatus}
        onRespondToInterrupt={onRespondToInterrupt}
        directResult={directResult}
      />
    </div>
  );
});

function thinkingLabel() {
  return <Trans>Thinking</Trans>;
}

function ThreadReportArtifact({
  refName,
  report,
}: {
  refName: string;
  report: import("./ReportContent").ReportContentValue;
}) {
  const [expanded, setExpanded] = useState(false);
  const subagent = useSubagentActivityByRef(refName);
  const openThread = useOpenChatThread();
  const agentName = subagent?.agentName?.trim() || refName || "Subagent";
  const preview =
    report.summary || (report.payload === undefined ? "" : payloadText(report.payload));
  return (
    <div
      className="rounded-lg border border-border bg-background px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] shadow-sm"
      data-thread-report={refName}
      data-subagent-thread-id={subagent?.threadId}
    >
      <div className="flex min-w-0 items-center gap-[var(--chat-space-row)]">
        <SubagentMark name={agentName} status="done" />
        <span className="shrink-0 text-sm font-medium text-foreground">{agentName}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          <Trans>Report</Trans>
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {subagent?.title || preview.split(/\r?\n/, 1)[0]}
        </span>
        {subagent && openThread ? (
          <button
            type="button"
            aria-label={t`Open subagent chat`}
            onClick={() => openThread(subagent.threadId)}
            className="focus-ring grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? t`Hide report` : t`Show report`}
          onClick={() => setExpanded((value) => !value)}
          className="focus-ring grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronDown
            className={cn("size-4 transition-transform", expanded && "rotate-180")}
            aria-hidden
          />
        </button>
      </div>
      {expanded ? (
        <ReportContent
          report={report}
          empty={<Trans>No report text was returned.</Trans>}
          className="mt-[var(--chat-space-block)] pl-8 space-y-[var(--chat-space-block)]"
        />
      ) : null}
    </div>
  );
}

function thinkingAriaLabel(processIndex: number, processCount: number): string | undefined {
  return processCount <= 1 ? t`Thinking` : t`Thinking part ${processIndex + 1}`;
}

/** A process item earns its disclosure only when it holds something the writer can read. */
function foldHasVisibleContent(runs: Run[]): boolean {
  return runs.some((run) => run.kind === "reasoning") || toolViewsInFold(runs).length > 0;
}

function toolViewsInFold(runs: Run[]) {
  return runs.flatMap((run) => {
    if (run.kind !== "activity") return [];
    return groupDeliverySegments(run.blocks).flatMap((segment) => {
      if (segment.kind === "tool") return isToolViewVisible(segment.tool) ? [segment.tool] : [];
      if (segment.kind === "tool-run") return segment.tools.filter(isToolViewVisible);
      return [];
    });
  });
}

const FoldRun = memo(function FoldRun({
  run,
  threadId,
  turnStatus,
  onRespondToInterrupt,
  writeMode,
}: {
  run: Run;
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  writeMode: "direct" | "draft";
}) {
  if (run.kind === "reasoning") {
    return (
      <>
        {run.blocks.filter(hasVisibleReasoningText).map((block) => (
          <TurnBlockStep key={blockRenderKey(block)} block={block} />
        ))}
      </>
    );
  }

  return (
    <div className="space-y-[var(--chat-space-row)]" data-activity-block data-fold-activity-run>
      <DeliverySegments
        blocks={run.blocks}
        threadId={threadId}
        turnStatus={turnStatus}
        onRespondToInterrupt={onRespondToInterrupt}
        writeMode={writeMode}
      />
    </div>
  );
});

// A turn with only empty blocks partitions to nothing, so a blockless item
// never reaches render. Returning a stable key instead of throwing keeps a
// stray empty item from tripping the project route error boundary.
function itemRenderKey(item: RenderItem): string {
  if (item.kind !== "process") return `${item.kind}:${blockRenderKey(item.block)}`;
  const firstBlock = item.runs[0]?.blocks[0];
  return firstBlock ? `process:${blockRenderKey(firstBlock)}` : "process:empty";
}

function runRenderKey(run: Run): string {
  const firstBlock = run.blocks[0];
  return firstBlock ? `${run.kind}:${blockRenderKey(firstBlock)}` : run.kind;
}

export const AssistantTurn = memo(AssistantTurnComponent);
AssistantTurn.displayName = "AssistantTurn";

const DeliverySegments = memo(function DeliverySegments({
  blocks,
  threadId,
  turnStatus,
  onRespondToInterrupt,
  writeMode,
}: {
  blocks: Block[];
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  writeMode: "direct" | "draft";
}) {
  const segments = useMemo(() => groupDeliverySegments(blocks), [blocks]);
  return (
    <>
      {segments.flatMap((segment) => {
        if (segment.kind === "tool") {
          return [
            <ToolRow
              key={blockRenderKey(segment.tool.keyBlock)}
              tool={segment.tool}
              writeMode={writeMode}
            />,
          ];
        }
        // Claude-style timeline: adjacent tools stack as siblings instead of
        // collapsing into a grouping disclosure. With text-altitude rows the
        // visual weight is low enough that grouping reads as extra chrome.
        if (segment.kind === "tool-run") {
          return segment.tools.map((tool) => (
            <ToolRow key={blockRenderKey(tool.keyBlock)} tool={tool} writeMode={writeMode} />
          ));
        }
        return [
          <DeliveryBlock
            key={blockRenderKey(segment.block)}
            block={segment.block}
            threadId={threadId}
            turnStatus={turnStatus}
            onRespondToInterrupt={onRespondToInterrupt}
          />,
        ];
      })}
    </>
  );
});

// Tool protocol blocks are normalized by `groupDeliverySegments` before this
// branch. Keeping DeliveryBlock tool-free prevents `(tool_*)` placeholders from
// leaking through the generic process renderer.
function DeliveryBlock({
  block,
  threadId,
  turnStatus,
  onRespondToInterrupt,
  directResult,
}: {
  block: Block;
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  directResult?: DirectInvocationResult | null;
}) {
  // `activity` blocks are AG-UI progress placeholders (`ACTIVITY_SNAPSHOT` /
  // `ACTIVITY_DELTA` events with no tool target) that the reducer parks under
  // a non-canonical blockType. They're transport-level liveness, not
  // deliverable content. Rendering them produces "(activity)" placeholder rows
  // during streaming; hide them here so the item list stays clean.
  if (block.blockType === ("activity" as Block["blockType"])) return null;

  if (isImageBlock(block)) {
    const content = imageContentForBlock(block);
    if (!content) return null;
    return <ImageBlock content={content} />;
  }
  if (block.blockType === "custom") {
    return (
      <CustomBlockRenderer
        block={block}
        threadId={threadId}
        turnStatus={turnStatus}
        onRespondToInterrupt={onRespondToInterrupt}
        directResult={directResult}
      />
    );
  }
  if (block.blockType === "text") {
    const text = block.textContent ?? "";
    if (!text.trim()) return null;
    // Text is the assistant's voice: full prose, no icon, no rail — and it is
    // only ever rendered here, outside the Thinking fold.
    if (block.status === "partial") {
      return <StreamingText text={text} />;
    }
    return <Markdown>{text}</Markdown>;
  }
  return <TurnBlockStep block={block} />;
}
