/** AssistantTurn — single render path for assistant turns. */

import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { type Block, isTerminalTurnStatus, type Turn } from "@meridian/contracts/protocol";
import { ChevronDown, MessageSquareText } from "lucide-react";
import { memo, useMemo } from "react";
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
import { CustomBlockRenderer, type InterruptRespondRequest } from "./CustomBlockRenderer";
import { ErrorBlock } from "./ErrorBlock";
import { groupDeliverySegments } from "./group-delivery-segments";
import { type DirectInvocationResult, directResultsForTurn } from "./invocation-direct-result";
import { OpenSubagentChatButton } from "./OpenSubagentChatButton";
import { ProcessDisclosure } from "./ProcessDisclosure";
import {
  hasVisibleReasoningText,
  partitionTurn,
  type RenderItem,
  type Run,
} from "./partition-turn";
import { ReportContent } from "./ReportContent";
import { StreamingText } from "./StreamingText";
import { useSubagentDisclosure } from "./subagent/DisclosureStore";
import { resolveSubagentName, subagentStatus } from "./subagent/display";
import { SubagentMark } from "./subagent/SubagentMark";
import type { SubagentUpdateMetadata } from "./subagent/update";
import { groupAdjacentSubagentUpdates } from "./subagent/update";
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
  /** Assistant turns in the same writer-facing reply, supplied on its final part. */
  responseParts?: readonly Turn[];
  threadUsage?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheReportedInputTokens: number;
    cacheReportedCalls: number;
    cacheWriteTokens: number;
    outputTokens: number;
    cacheResets: number;
  } | null;
  deliveryEvents?: Array<{
    turn: Turn;
    childThreadId?: string;
    title?: string;
    subagentUpdate: SubagentUpdateMetadata | null;
  }>;
  isLatestAssistant?: boolean;
  /**
   * The next visible turn continues this response (a subagent notification
   * woke the model, with no writer message between), so this part has no
   * settled action row of its own.
   */
  continuesResponse?: boolean;
  onRetry?: () => void;
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  changeTrail?: ChangeTrailShell;
  navigateToChange?: NavigateToTrailChange;
};

function AssistantTurnComponent({
  threadId,
  turn,
  responseParts,
  threadUsage,
  deliveryEvents = [],
  isLatestAssistant = false,
  continuesResponse = false,
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
        {rows.map(({ item, processOrdinal, processCount }) => (
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
          />
        ))}
        {deliveryEvents.length ? (
          <div data-turn-item-kind="delivery">
            <DeliveryEventRows events={deliveryEvents} />
          </div>
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
      {isSettled && !continuesResponse ? (
        <AssistantTurnActions
          threadId={resolvedThreadId}
          turn={turn}
          responseParts={responseParts ?? [turn]}
          markdown={copyMarkdown}
          threadUsage={threadUsage ?? null}
        />
      ) : null}
      {showsInkDrop ? <InkDrop /> : null}
    </div>
  );
}

type DeliveryEvent = NonNullable<AssistantTurnProps["deliveryEvents"]>[number];

function DeliveryEventRows({ events }: { events: DeliveryEvent[] }) {
  const groups = groupAdjacentSubagentUpdates(events);
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
  const entries = events.map((event) => {
    const update = event.subagentUpdate;
    return {
      event,
      update,
      agentName: update?.agentName,
      name: resolveSubagentName({ agentName: update?.agentName }),
      description: event.title ?? null,
      threadId: update?.childThreadId ?? event.childThreadId,
      outcome: update?.outcome,
    };
  });
  const names = entries.map(({ name }) => name);
  const stopped = entries.filter(({ outcome }) => outcome === "failed" || outcome === "cancelled");
  const list = (values: string[]) =>
    new Intl.ListFormat(i18n.locale, { style: "long", type: "conjunction" }).format(values);
  const childIds = entries.flatMap(({ threadId }) => (threadId ? [threadId] : []));
  const [expanded, setExpanded] = useSubagentDisclosure(
    `merged:${events.map((event) => event.turn.id).join(":")}`,
  );
  return (
    <div className="min-w-0 text-sm text-muted-foreground" data-subagent-finished>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        data-subagent-thread-ids={childIds.join(" ")}
        data-subagent-disclosure-key={`merged:${events.map((event) => event.turn.id).join(":")}`}
        className="focus-ring flex w-full items-center gap-2 rounded-sm py-[var(--chat-space-row)] text-left hover:text-foreground"
      >
        <span className="flex -space-x-1.5">
          {names.slice(0, 3).map((name, index) => (
            <span key={`${name}-${index}`} className="rounded-full bg-background p-[2px]">
              <SubagentMark
                agentName={entries[index]?.agentName}
                status={subagentStatus(entries[index]?.outcome)}
                className="size-5 text-[10px]"
                decorative
              />
            </span>
          ))}
        </span>
        <span className="truncate font-medium text-foreground">
          {names.length > 3 || new Set(names).size < names.length ? (
            stopped.length ? (
              <Trans>
                {names.length} subagents finished ({stopped.length} stopped)
              </Trans>
            ) : (
              <Trans>{names.length} subagents finished</Trans>
            )
          ) : stopped.length === 0 ? (
            <Trans>{list(names)} finished</Trans>
          ) : stopped.length === entries.length ? (
            <Trans>{list(names)} stopped</Trans>
          ) : (
            <Trans>
              {list(
                entries.map(
                  ({ name, outcome }) =>
                    `${name} ${outcome === "succeeded" ? i18n._("finished") : i18n._("stopped")}`,
                ),
              )}
            </Trans>
          )}
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 transition-transform", expanded && "rotate-180")}
          aria-hidden
        />
      </button>
      {expanded ? (
        <div className="ml-7 space-y-1 border-l border-border-subtle py-1 pl-3">
          {entries.map(({ name, description, threadId, agentName, outcome }, index) => (
            <div key={`${threadId ?? name}-${index}`} data-subagent-thread-id={threadId}>
              <div className="flex items-center gap-2">
                <SubagentMark
                  agentName={agentName}
                  status={subagentStatus(outcome)}
                  className="size-5 text-[10px]"
                />
                <span className="min-w-0 truncate py-1">
                  <span className="font-medium text-foreground">{name}</span>
                  {description ? <span className="ml-1.5">{description}</span> : null}
                </span>
                <OpenSubagentChatButton threadId={threadId} agentName={agentName} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DeliveryEventRow({ turn, childThreadId, title, subagentUpdate }: DeliveryEvent) {
  if (subagentUpdate) {
    const agentName = subagentUpdate.agentName;
    const name = resolveSubagentName({ agentName });
    const description = title ?? null;
    const outcome = subagentUpdate.outcome;
    const threadId = subagentUpdate.childThreadId ?? childThreadId;
    return (
      <div
        className="min-w-0 text-sm text-muted-foreground"
        data-subagent-finished
        data-subagent-thread-id={threadId ?? undefined}
      >
        <div className="flex items-center gap-2">
          <SubagentMark
            agentName={agentName}
            status={subagentStatus(outcome)}
            className="size-5 text-[10px]"
            decorative
          />
          <span className="min-w-0 truncate py-[var(--chat-space-row)]">
            <span className="font-medium text-foreground">{name}</span>{" "}
            {description ? <>{description} </> : null}
            {outcome === "succeeded" ? <Trans>finished</Trans> : <Trans>stopped</Trans>}
          </span>
          {/* Beside the text, not at the far edge, so the door reads as part of the line. */}
          <OpenSubagentChatButton threadId={threadId} agentName={agentName} />
        </div>
      </div>
    );
  }
  const body = turn.blocks
    .filter((block) => block.blockType === "text")
    .map((block) => block.textContent ?? "")
    .join("");
  return (
    <ActivityRow Icon={MessageSquareText}>
      <span className="whitespace-pre-wrap text-foreground">
        {body || <Trans>Shared an attachment</Trans>}
      </span>
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
}: {
  item: RenderItem;
  processOrdinal: number;
  processCount: number;
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  writeMode: "direct" | "draft";
  directResult: DirectInvocationResult | null;
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
      </div>
    );
  }

  if (item.kind === "report") {
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
