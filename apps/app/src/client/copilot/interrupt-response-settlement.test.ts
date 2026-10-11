/**
 * Contract tests for interrupt-response settlement ownership.
 *
 * The controller owns the local settlement for an `interrupt.respond` send:
 * every send that is not confirmed is a retryable `failed` (a refusal, a
 * socket-generation close, a closed socket), a refusal also refetches the
 * thread snapshot so the server's truth can clear the entry, and the matching
 * server resolution event or a snapshot that shows the question settled
 * clears it. The routing boundary for non-fatal interrupt errors lives in
 * `dispatch-ws-server-message.test.ts`.
 */
import type { AGUIEvent, Block, JsonValue, Thread, Turn } from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { MeridianApiError } from "@/client/api/meridian-error";

import { ThreadRunScenario } from "./test-support/ThreadRunScenario";

const THREAD = "thread_1";
const TURN = "turn_1";
const INTERRUPT = "interrupt_1";

const response = {
  threadId: THREAD,
  turnId: TURN,
  interruptId: INTERRUPT,
  value: { value: "yes" },
} as const;

function interruptError(code: string): MeridianApiError {
  return new MeridianApiError({
    code,
    message: code,
    retryable: false,
    source: "system",
  });
}

function resolutionEvent(state: "resolved" | "expired" = "resolved"): AGUIEvent {
  return {
    type: EventType.CUSTOM,
    name: "meridian.interrupt",
    value: {
      turnId: TURN,
      interruptId: INTERRUPT,
      blockSequence: 0,
      state,
      value: state === "resolved" ? "yes" : null,
      provenance: state === "resolved" ? "user" : "auto",
    },
  } as AGUIEvent;
}

function pendingEntry(scenario: ThreadRunScenario) {
  return scenario.store.getState().interruptResponses?.[interruptKey()];
}

function interruptKey(interruptId: string = INTERRUPT): string {
  return `${THREAD}\u0000${TURN}\u0000${interruptId}`;
}

describe("interrupt response settlement", () => {
  it("fails an answer the server no longer holds and asks the server what became of the question", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);

    scenario.transport.emitInterruptResponseError(THREAD, interruptError("interrupt_not_pending"));

    expect(pendingEntry(scenario)).toMatchObject({ status: "failed", value: { value: "yes" } });
    expect(scenario.snapshotInvalidations).toEqual([THREAD]);
  });

  it("clears a failed answer when the refetched snapshot shows the question resolved elsewhere", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);
    scenario.transport.emitInterruptResponseError(THREAD, interruptError("interrupt_not_pending"));

    applySnapshot(
      scenario,
      assistantTurn("waiting_interrupt", [
        interruptBlock(INTERRUPT, { resolvedValue: "no", answerProvenance: "user" }),
      ]),
    );

    expect(pendingEntry(scenario)).toBeUndefined();
  });

  it("clears a failed answer when the refetched snapshot shows the run ended", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);
    scenario.transport.emitInterruptResponseError(THREAD, interruptError("interrupt_not_pending"));

    applySnapshot(scenario, assistantTurn("complete", [interruptBlock(INTERRUPT)]));

    expect(pendingEntry(scenario)).toBeUndefined();
  });

  it("keeps a failed answer, with its value, while the snapshot still shows the question open", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);
    scenario.transport.emitInterruptResponseError(THREAD, interruptError("interrupt_not_pending"));

    applySnapshot(scenario, assistantTurn("waiting_interrupt", [interruptBlock(INTERRUPT)]));

    expect(pendingEntry(scenario)).toMatchObject({ status: "failed", value: { value: "yes" } });
  });

  it("treats a correlation mismatch as a retryable failure too", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);

    scenario.transport.emitInterruptResponseError(
      THREAD,
      interruptError("interrupt_correlation_mismatch"),
    );

    expect(pendingEntry(scenario)).toMatchObject({ status: "failed" });
  });

  it("fails a sent response when its socket generation closes, and not another generation's", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);
    const generation = scenario.transport.socketGeneration;

    scenario.closeSocket(generation + 1);
    expect(pendingEntry(scenario)).toMatchObject({ status: "pending" });

    scenario.closeSocket(generation);
    expect(pendingEntry(scenario)).toMatchObject({ status: "failed" });
  });

  it("still settles to the server resolution after the socket closes", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);
    scenario.resume({ expectedTurnId: TURN });

    scenario.closeSocket();
    scenario.emit(resolutionEvent(), "6");

    expect(pendingEntry(scenario)).toBeUndefined();
  });

  it("does not send a second frame on a double click and keeps the first value", () => {
    const scenario = new ThreadRunScenario();

    expect(scenario.controller.respondInterrupt(response)).toEqual({ status: "pending" });
    scenario.controller.respondInterrupt({ ...response, value: { value: "no" } });

    expect(scenario.transport.interruptResponses).toHaveLength(1);
    expect(pendingEntry(scenario)).toMatchObject({ status: "pending", value: { value: "yes" } });
  });

  it("clears a settlement when a snapshot already shows the interrupt resolved", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);

    applySnapshot(
      scenario,
      assistantTurn("waiting_interrupt", [
        interruptBlock(INTERRUPT, { resolvedValue: "yes", answerProvenance: "user" }),
      ]),
    );

    expect(pendingEntry(scenario)).toBeUndefined();
  });
});

function interruptBlock(interruptId: string, props: Record<string, JsonValue> = {}): Block {
  return {
    id: `block_${interruptId}`,
    turnId: TURN,
    responseId: null,
    blockType: "custom",
    sequence: 0,
    content: { kind: "choice", props, interrupt: { id: interruptId } },
  } as unknown as Block;
}

function assistantTurn(status: Turn["status"], blocks: Block[]): Turn {
  return {
    id: TURN,
    threadId: THREAD,
    role: "assistant",
    status,
    blocks,
  } as unknown as Turn;
}

function applySnapshot(scenario: ThreadRunScenario, turn: Turn): void {
  scenario.store
    .getState()
    .applyThreadSnapshot({ id: THREAD, projectId: "project_1" } as unknown as Thread, [turn], {
      lifecycle: { actionRequired: false, runningTurnId: null },
      nextSeq: "10",
    });
}
