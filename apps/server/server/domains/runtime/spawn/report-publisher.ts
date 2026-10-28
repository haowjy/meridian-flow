/**
 * Parent-first publication B for immutable child execution reports. An asked
 * report whose question resolved with no continuation left to run (withdrawn, or
 * its continuation dropped by a cancellation) projects as a cancelled invocation:
 * the report stays immutable, the card and spawn status stop waiting on it.
 */

import { GENERIC_SUBAGENT_SLUG } from "@meridian/contracts/agents";
import { buildInvocationCardContent, parseInvocationCard } from "@meridian/contracts/components";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import type { OrchestratorEvent, QuestionAskPayload } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { LiveEventWriter, StoredAsk, ThreadRepositories } from "../../threads/index.js";
import { contentForBlockInput } from "../loop/block-helpers.js";
import { persistAndAppendEvents } from "../loop/persistence.js";
import type { DeliveryProducer, RuntimeDelivery } from "../loop/runtime-delivery.js";
import { readAskContinuation } from "./ask-continuation.js";
import { childQuestionText } from "./model-spawn-result.js";
import { invocationAgentName, invocationCardProps } from "./spawn-output.js";

export type PublicationOutcome = "published" | "parked" | "already";

export interface ReportPublisher {
  projectRunning(childThreadId: ThreadId, executionTurnId: TurnId): Promise<void>;
  publish(childThreadId: ThreadId, executionTurnId: TurnId): Promise<PublicationOutcome>;
  /** Finalizes a child parked on a question whose continuation was cancelled; a no-op otherwise. */
  settleCancelledAsk(childThreadId: ThreadId): Promise<void>;
  sweep(limit: number): Promise<number>;
}

export function createReportPublisher(deps: {
  repos: ThreadRepositories;
  eventWriter: LiveEventWriter;
  delivery: DeliveryProducer & Pick<RuntimeDelivery, "selectPending">;
  eventSink: EventSink;
}): ReportPublisher {
  let cursor: TurnId | undefined;

  /** The asked report's question; `cancelled` when that question was withdrawn. */
  async function askedQuestion(report: SavedExecutionReport) {
    if (report.outcome !== "asked" || !report.terminalTurnId) return null;
    const ask = (await deps.repos.asks.listByTurnIds([report.terminalTurnId])).find(
      (candidate) => candidate.kind === "question",
    );
    if (!ask) throw new Error("Asked execution report has no historical question");
    return ask;
  }

  /** Whether an asked report's question resolved and nothing will continue it. */
  async function continuationCancelled(report: SavedExecutionReport, ask: StoredAsk | null) {
    if (!ask || ask.status === "open" || ask.status === "pending") return false;
    const continuation = await readAskContinuation(
      { delivery: deps.delivery, executionReports: deps.repos.executionReports },
      report.childThreadId,
      ask.id,
    );
    return continuation.kind === "cancelled";
  }

  /** What the invocation shows for this report: a cancelled continuation ends it cancelled. */
  async function projectedTerminal(report: SavedExecutionReport, ask: StoredAsk | null) {
    return (await continuationCancelled(report, ask))
      ? { outcome: "cancelled" as const, terminalAt: ask?.resolvedAt?.toISOString() ?? null }
      : { outcome: report.outcome, terminalAt: report.terminalAt };
  }

  async function cardProjection(
    report: SavedExecutionReport,
    state: "running" | "terminal",
    terminal: { outcome: SavedExecutionReport["outcome"]; terminalAt: string | null } = report,
  ): Promise<OrchestratorEvent | null> {
    if (!report.cardBlockId || !report.callerTurnId) return null;
    if (!report.toolCallId || report.deliveryMode === "none")
      throw new Error("Card-bearing report has incomplete invocation correlation");
    const card = await deps.repos.blocks.findById(report.cardBlockId);
    if (!card) return null;
    if (card.turnId !== report.callerTurnId || card.blockType !== "custom")
      throw new Error("Execution report card no longer belongs to its caller turn");
    const priorProps = parseInvocationCard(card.content);
    if (state === "running" && priorProps?.outcome !== "asked") return null;
    const projectedExecution =
      priorProps?.childThreadId === report.childThreadId ? priorProps.execution : null;
    const [projectedTurn, reportTurn, child] = await Promise.all([
      projectedExecution ? deps.repos.turns.findById(projectedExecution) : null,
      deps.repos.turns.findById(report.executionTurnId),
      deps.repos.threads.findById(report.childThreadId),
    ]);
    if (projectedTurn && reportTurn && projectedTurn.position > reportTurn.position) return null;
    const agentName = invocationAgentName(
      report.agentSlug ?? GENERIC_SUBAGENT_SLUG,
      child?.agentName,
    );
    return {
      type: "block.updated",
      block: contentForBlockInput({
        id: card.id,
        turnId: card.turnId,
        blockType: "custom",
        sequence: card.sequence,
        content: buildInvocationCardContent(
          invocationCardProps({
            agent: report.agentSlug ?? undefined,
            agentName,
            name: report.name ?? undefined,
            correlation: {
              parentTurnId: report.callerTurnId,
              toolCallId: report.toolCallId,
              deliveryMode: report.deliveryMode,
            },
            childThreadId: report.childThreadId,
            execution: report.executionTurnId,
            startedAt: report.admittedAt,
            terminalAt: state === "terminal" ? terminal.terminalAt : null,
            ...(state === "terminal" && terminal.outcome ? { outcome: terminal.outcome } : {}),
            fromThreadId: priorProps?.fromThreadId,
            fromThreadRef: priorProps?.fromThreadRef,
            fromThreadTitle: priorProps?.fromThreadTitle,
          }),
        ),
        status: "complete",
      }),
    };
  }

  async function projectRunning(childThreadId: ThreadId, executionTurnId: TurnId): Promise<void> {
    const report = await deps.repos.executionReports.findByExecution(
      childThreadId,
      executionTurnId,
    );
    if (!report || report.outcome !== null || !report.callerThreadId) return;
    await deps.delivery.withThreadLock(report.callerThreadId, async () => {
      await deps.repos.transaction(async () => {
        const event = await cardProjection(report, "running");
        if (event)
          await persistAndAppendEvents(deps, report.callerThreadId as ThreadId, async () => ({
            result: null,
            events: [event],
          }));
      });
    });
  }

  async function publish(childThreadId: ThreadId, executionTurnId: TurnId) {
    const selected = await deps.repos.executionReports.findByExecution(
      childThreadId,
      executionTurnId,
    );
    if (selected?.publication !== "pending") return "already";
    // A pending publication can only be admitted for an invocation with a caller.
    const callerThreadId = selected.callerThreadId;
    if (!callerThreadId) {
      throw new Error("Pending publication violates caller-thread invariant");
    }

    // DeliveryProducer owns the parent lock, and its scoped producer never takes it
    // again. No child lock or lease wait is reachable from this callback.
    return deps.delivery.withThreadLock(callerThreadId, async (producer) =>
      deps.repos.transaction(async (): Promise<PublicationOutcome> => {
        const callerRow = await deps.repos.threads.lockByIdIncludingDeleted(callerThreadId);
        if (!callerRow) {
          throw new Error("Pending publication violates caller-thread invariant");
        }
        const report = await deps.repos.executionReports.lockPendingPublication(
          childThreadId,
          executionTurnId,
        );
        if (!report) return "already";
        // Soft deletion of the caller or its project parks the obligation.
        // Restoration will make it eligible to the bounded sweep again.
        if (callerRow.deletedAt || !(await deps.repos.threads.findById(callerThreadId))) {
          return "parked";
        }
        if (report.outcome === null) {
          throw new Error("Pending execution report has no terminal outcome");
        }
        const child = await deps.repos.threads.findById(report.childThreadId);
        const agentName = invocationAgentName(
          report.agentSlug ?? GENERIC_SUBAGENT_SLUG,
          child?.agentName,
        );

        const asked = await askedQuestion(report);
        const actionableAsk = asked?.status === "open" ? asked : null;
        const events = await terminalEvents(report, asked, callerThreadId);
        await persistAndAppendEvents(deps, callerThreadId, async () => ({
          result: null,
          events,
        }));
        if (report.deliveryMode === "background_notification") {
          const question = actionableAsk ? (actionableAsk.payload as QuestionAskPayload) : null;
          // A delayed asked publication whose question already settled has no
          // actionable notification. Its ordered card projection still runs,
          // then the obligation is retired below.
          if (report.outcome !== "asked" || (actionableAsk && question)) {
            await producer.enqueue({
              threadId: callerThreadId,
              intent: "message",
              provenance: {
                kind: "child",
                threadId: report.childThreadId,
                handle: report.handle,
                agentName,
                ...(actionableAsk && question
                  ? {
                      ask: {
                        id: actionableAsk.id,
                        question: question.question,
                        options: question.options.map((option) => option.label),
                        ...(question.recommended ? { recommended: question.recommended } : {}),
                      },
                    }
                  : { reportId: report.executionTurnId, outcome: report.outcome }),
              },
              body: {
                kind: "text",
                text:
                  actionableAsk && question
                    ? childQuestionText(
                        report.handle,
                        actionableAsk.id,
                        question.question,
                        question.options.map((option) => option.label),
                      )
                    : notificationText(report),
              },
              idempotencyKey: actionableAsk
                ? `child-question:${actionableAsk.id}`
                : `child-report:${report.executionTurnId}`,
            });
          }
        }
        await deps.repos.executionReports.markPublished(
          childThreadId,
          executionTurnId,
          "published",
        );
        return "published";
      }),
    );
  }

  async function terminalEvents(
    report: SavedExecutionReport,
    asked: StoredAsk | null,
    callerThreadId: ThreadId,
  ): Promise<OrchestratorEvent[]> {
    const terminal = await projectedTerminal(report, asked);
    const events: OrchestratorEvent[] = [];
    const cardEvent = await cardProjection(report, "terminal", terminal);
    if (cardEvent) events.push(cardEvent);
    if (terminal.outcome && terminal.outcome !== "asked") {
      events.push({
        type: "agent.run_completed",
        parentThreadId: callerThreadId,
        parentTurnId: report.callerTurnId,
        childThreadId: report.childThreadId,
        execution: report.executionTurnId,
        handle: report.handle,
        outcome: terminal.outcome,
      });
    }
    return events;
  }

  async function settleCancelledAsk(childThreadId: ThreadId): Promise<void> {
    const report = await deps.repos.executionReports.findLatestFinishedByChild(childThreadId);
    if (report?.outcome !== "asked") return;
    const asked = await askedQuestion(report);
    if (!(await continuationCancelled(report, asked))) return;
    if (report.origin === "spawn")
      await deps.repos.threads.updateSpawnLifecycle(childThreadId, { spawnStatus: "cancelled" });
    // An unpublished asked report takes the same projection through its obligation.
    if (report.publication === "pending") {
      await publish(childThreadId, report.executionTurnId);
      return;
    }
    const callerThreadId = report.callerThreadId;
    if (!callerThreadId) return;
    await deps.delivery.withThreadLock(callerThreadId, async () => {
      await deps.repos.transaction(async () => {
        const events = await terminalEvents(report, asked, callerThreadId);
        if (events.length > 0)
          await persistAndAppendEvents(deps, callerThreadId, async () => ({
            result: null,
            events,
          }));
      });
    });
  }

  async function sweep(limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Publication limit must be positive");
    let candidates = await deps.repos.executionReports.listPendingPublication(limit, cursor);
    if (candidates.length === 0 && cursor) {
      cursor = undefined;
      candidates = await deps.repos.executionReports.listPendingPublication(limit);
    }
    for (const candidate of candidates) {
      cursor = candidate.executionTurnId;
      try {
        await publish(candidate.childThreadId, candidate.executionTurnId);
      } catch (error) {
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "runtime.report-publication",
          name: "publication.failed",
          correlation: {
            threadId: candidate.childThreadId,
            turnId: candidate.executionTurnId,
          },
          payload: unknownToEventPayload(error),
        });
      }
    }
    return candidates.length;
  }

  return { projectRunning, publish, settleCancelledAsk, sweep };
}

function notificationText(report: SavedExecutionReport): string {
  return `Subagent ${report.handle} finished (${report.outcome}). Read its report with thread_report({"ref":"${report.handle}"}).`;
}
