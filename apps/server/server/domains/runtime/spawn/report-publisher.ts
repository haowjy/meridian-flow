/** Parent-first publication B for immutable child execution reports. */

import { GENERIC_SUBAGENT_SLUG } from "@meridian/contracts/agents";
import { buildInvocationCardContent, parseInvocationCard } from "@meridian/contracts/components";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { EventJournalWriter, ThreadRepositories } from "../../threads/index.js";
import { contentForBlockInput } from "../loop/block-helpers.js";
import { persistAndAppendEvents } from "../loop/persistence.js";
import type { DeliveryProducer } from "../loop/runtime-delivery.js";
import { invocationAgentName, invocationCardProps } from "./spawn-output.js";

export type PublicationOutcome = "published" | "parked" | "already";

export interface ReportPublisher {
  publish(childThreadId: ThreadId, executionTurnId: TurnId): Promise<PublicationOutcome>;
  sweep(limit: number): Promise<number>;
}

export function createReportPublisher(deps: {
  repos: ThreadRepositories;
  eventWriter: EventJournalWriter;
  delivery: DeliveryProducer;
  eventSink: EventSink;
}): ReportPublisher {
  let cursor: TurnId | undefined;

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

        const events: OrchestratorEvent[] = [];
        if (report.cardBlockId && report.callerTurnId) {
          if (!report.toolCallId || report.deliveryMode === "none") {
            throw new Error("Card-bearing report has incomplete invocation correlation");
          }
          const card = await deps.repos.blocks.findById(report.cardBlockId);
          if (card) {
            if (card.turnId !== report.callerTurnId || card.blockType !== "custom") {
              throw new Error("Execution report card no longer belongs to its caller turn");
            }
            const priorProps = parseInvocationCard(card.content);
            events.push({
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
                    description: report.description ?? undefined,
                    correlation: {
                      parentTurnId: report.callerTurnId,
                      toolCallId: report.toolCallId,
                      deliveryMode: report.deliveryMode,
                    },
                    childThreadId: report.childThreadId,
                    execution: report.executionTurnId,
                    startedAt: report.admittedAt,
                    terminalAt: report.terminalAt,
                    outcome: report.outcome,
                    fromThreadId: priorProps?.fromThreadId,
                    fromThreadRef: priorProps?.fromThreadRef,
                    fromThreadTitle: priorProps?.fromThreadTitle,
                  }),
                ),
                status: "complete",
              }),
            });
          }
        }
        events.push({
          type: "agent.run_completed",
          parentThreadId: callerThreadId,
          parentTurnId: report.callerTurnId,
          childThreadId: report.childThreadId,
          execution: report.executionTurnId,
          handle: report.handle,
          outcome: report.outcome,
        });
        await persistAndAppendEvents(deps, callerThreadId, async () => ({
          result: null,
          events,
        }));
        if (report.deliveryMode === "background_notification") {
          await producer.enqueue({
            threadId: callerThreadId,
            intent: "message",
            provenance: {
              kind: "child",
              threadId: report.childThreadId,
              reportId: report.executionTurnId,
              handle: report.handle,
              outcome: report.outcome,
              agentName,
            },
            body: { kind: "text", text: notificationText(report) },
            idempotencyKey: `child-report:${report.executionTurnId}`,
          });
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

  return { publish, sweep };
}

function notificationText(report: SavedExecutionReport): string {
  return `Subagent ${report.handle} finished (${report.outcome}). Read its report with thread_report({"ref":"${report.handle}"}).`;
}
