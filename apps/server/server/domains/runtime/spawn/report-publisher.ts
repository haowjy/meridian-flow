/** Parent-first publication B for immutable child execution reports. */

import { GENERIC_SUBAGENT_SLUG } from "@meridian/contracts/agents";
import { buildInvocationCardContent, parseInvocationCard } from "@meridian/contracts/components";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { LiveEventWriter, ThreadRepositories } from "../../threads/index.js";
import { contentForBlockInput } from "../loop/block-helpers.js";
import { persistAndAppendEvents } from "../loop/persistence.js";
import type { DeliveryProducer } from "../loop/runtime-delivery.js";
import { invocationAgentName, invocationCardProps } from "./spawn-output.js";

export type PublicationOutcome = "published" | "parked" | "already";

export interface ReportPublisher {
  projectRunning(childThreadId: ThreadId, executionTurnId: TurnId): Promise<void>;
  publish(childThreadId: ThreadId, executionTurnId: TurnId): Promise<PublicationOutcome>;
  sweep(limit: number): Promise<number>;
}

export function createReportPublisher(deps: {
  repos: ThreadRepositories;
  eventWriter: LiveEventWriter;
  delivery: DeliveryProducer;
  eventSink: EventSink;
}): ReportPublisher {
  let cursor: TurnId | undefined;

  async function cardProjection(
    report: SavedExecutionReport,
    state: "running" | "terminal",
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
            terminalAt: state === "terminal" ? report.terminalAt : null,
            ...(state === "terminal" && report.outcome ? { outcome: report.outcome } : {}),
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

        const asked =
          report.outcome === "asked" && report.terminalTurnId
            ? (await deps.repos.asks.listByTurnIds([report.terminalTurnId])).find(
                (candidate) => candidate.kind === "question",
              )
            : null;
        if (report.outcome === "asked" && !asked) {
          throw new Error("Asked execution report has no historical question");
        }
        const actionableAsk = asked?.status === "open" ? asked : null;
        const events: OrchestratorEvent[] = [];
        const cardEvent = await cardProjection(report, "terminal");
        if (cardEvent) events.push(cardEvent);
        if (report.outcome !== "asked") {
          events.push({
            type: "agent.run_completed",
            parentThreadId: callerThreadId,
            parentTurnId: report.callerTurnId,
            childThreadId: report.childThreadId,
            execution: report.executionTurnId,
            handle: report.handle,
            outcome: report.outcome,
          });
        }
        await persistAndAppendEvents(deps, callerThreadId, async () => ({
          result: null,
          events,
        }));
        if (report.deliveryMode === "background_notification") {
          const question = actionableAsk
            ? (actionableAsk.payload as import("@meridian/contracts/threads").QuestionAskPayload)
            : null;
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
                    ? questionText(report.handle, actionableAsk.id, question)
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

  return { projectRunning, publish, sweep };
}

function questionText(
  handle: string,
  askId: string,
  payload: import("@meridian/contracts/threads").QuestionAskPayload,
): string {
  const options = payload.options.map((option) => option.label).join(", ");
  return `@${handle} asks (ask ${askId}): ${payload.question} (options: ${options})`;
}

function notificationText(report: SavedExecutionReport): string {
  return `Subagent ${report.handle} finished (${report.outcome}). Read its report with thread_report({"ref":"${report.handle}"}).`;
}
