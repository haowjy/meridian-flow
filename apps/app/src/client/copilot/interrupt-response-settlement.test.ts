/**
 * Contract tests for interrupt-response settlement ownership.
 *
 * The controller owns the local settlement for an `interrupt.respond` send:
 * it records pending before/while the frame is on the wire, a proven send
 * failure becomes a retryable `failed`, a duplicate `interrupt_not_pending`
 * after a send becomes `ambiguous` (the first attempt likely landed), a
 * correlation mismatch is a retryable `failed`, and the matching server
 * resolution event clears the entry. The agent outcome stays server-confirmed.
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
  it("marks a sent response pending before any server confirmation", () => {
    const scenario = new ThreadRunScenario();

    const status = scenario.controller.respondInterrupt(response);

    expect(status).toEqual({ status: "pending" });
    expect(pendingEntry(scenario)).toMatchObject({ status: "pending", value: { value: "yes" } });
  });

  it("records a proven send failure when the transport never sent the frame", () => {
    const scenario = new ThreadRunScenario();
    scenario.transport.interruptSendFails = true;

    const status = scenario.controller.respondInterrupt(response);

    expect(status).toEqual({ status: "failed" });
    expect(pendingEntry(scenario)).toMatchObject({ status: "failed" });
  });

  it("treats a duplicate interrupt_not_pending as ambiguous, not rejected", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);

    scenario.transport.emitInterruptResponseError(THREAD, interruptError("interrupt_not_pending"));

    expect(pendingEntry(scenario)).toMatchObject({ status: "ambiguous" });
  });

  it("treats a correlation mismatch as a retryable failure", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);

    scenario.transport.emitInterruptResponseError(
      THREAD,
      interruptError("interrupt_correlation_mismatch"),
    );

    expect(pendingEntry(scenario)).toMatchObject({ status: "failed" });
  });

  it("clears the settlement when the matching server resolution event arrives", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);
    scenario.resume({ expectedTurnId: TURN });

    scenario.emit(resolutionEvent(), "5");

    expect(pendingEntry(scenario)).toBeUndefined();
  });

  it("ignores a late error frame for a thread with no pending response", () => {
    const scenario = new ThreadRunScenario();

    scenario.transport.emitInterruptResponseError(THREAD, interruptError("interrupt_not_pending"));

    expect(pendingEntry(scenario)).toBeUndefined();
  });

  it("keeps the run subscription alive when an interrupt error frame arrives", () => {
    const scenario = new ThreadRunScenario();
    scenario.resume({ expectedTurnId: TURN });
    scenario.controller.respondInterrupt(response);

    scenario.transport.emitInterruptResponseError(THREAD, interruptError("interrupt_not_pending"));

    expect(scenario.activeSubscription()).toBeDefined();
    // The same subscription still applies the later server resolution.
    scenario.emit(resolutionEvent(), "6");
    expect(pendingEntry(scenario)).toBeUndefined();
  });

  it("clears the settlement when the matching server expiry event arrives", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);
    scenario.resume({ expectedTurnId: TURN });

    scenario.emit(resolutionEvent("expired"), "5");

    expect(pendingEntry(scenario)).toBeUndefined();
  });

  it("marks a sent response ambiguous when its socket generation closes", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);
    const generation = scenario.transport.socketGeneration;

    scenario.closeSocket(generation);

    expect(pendingEntry(scenario)).toMatchObject({ status: "ambiguous" });
  });

  it("leaves another generation's pending response alone", () => {
    const scenario = new ThreadRunScenario();
    scenario.transport.socketGeneration = 7;
    scenario.controller.respondInterrupt(response);

    scenario.closeSocket(8);

    expect(pendingEntry(scenario)).toMatchObject({ status: "pending" });
  });

  it("still settles to the server resolution after the socket closes", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);
    scenario.resume({ expectedTurnId: TURN });

    scenario.closeSocket();
    scenario.emit(resolutionEvent(), "6");

    expect(pendingEntry(scenario)).toBeUndefined();
  });

  it("does not send a second frame while the tuple is already pending", () => {
    const scenario = new ThreadRunScenario();

    expect(scenario.controller.respondInterrupt(response)).toEqual({ status: "pending" });
    expect(scenario.controller.respondInterrupt(response)).toEqual({ status: "pending" });

    expect(scenario.transport.interruptResponses).toHaveLength(1);
  });

  it("keeps the retained value when a double click sends a different one", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);

    scenario.controller.respondInterrupt({ ...response, value: { value: "no" } });

    expect(pendingEntry(scenario)).toMatchObject({ status: "pending", value: { value: "yes" } });
    expect(scenario.transport.interruptResponses).toHaveLength(1);
  });

  it("allows a new write after a proven failure", () => {
    const scenario = new ThreadRunScenario();
    scenario.transport.interruptSendFails = true;
    expect(scenario.controller.respondInterrupt(response)).toEqual({ status: "failed" });

    scenario.transport.interruptSendFails = false;
    expect(scenario.controller.respondInterrupt(response)).toEqual({ status: "pending" });

    expect(scenario.transport.interruptResponses).toHaveLength(2);
  });

  it("binds a thread-only error frame to the newest pending tuple", () => {
    const scenario = new ThreadRunScenario();
    const older = { ...response, interruptId: "interrupt_older" };
    const newer = { ...response, interruptId: "interrupt_newer" };
    scenario.controller.respondInterrupt(older);
    scenario.controller.respondInterrupt(newer);

    scenario.transport.emitInterruptResponseError(THREAD, interruptError("interrupt_not_pending"));

    expect(
      scenario.store.getState().interruptResponses[interruptKey("interrupt_older")],
    ).toMatchObject({ status: "pending" });
    expect(
      scenario.store.getState().interruptResponses[interruptKey("interrupt_newer")],
    ).toMatchObject({ status: "ambiguous" });
  });

  it("no-ops a thread-only error frame when the thread has no pending tuple", () => {
    const scenario = new ThreadRunScenario();

    scenario.transport.emitInterruptResponseError(THREAD, interruptError("interrupt_not_pending"));

    expect(scenario.store.getState().interruptResponses).toEqual({});
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

  it("clears a settlement when the snapshot turn is no longer waiting", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);

    applySnapshot(scenario, assistantTurn("streaming", [interruptBlock(INTERRUPT)]));

    expect(pendingEntry(scenario)).toBeUndefined();
  });

  it("marks a still-pending settlement ambiguous when the snapshot still waits", () => {
    const scenario = new ThreadRunScenario();
    scenario.controller.respondInterrupt(response);

    applySnapshot(scenario, assistantTurn("waiting_interrupt", [interruptBlock(INTERRUPT)]));

    expect(pendingEntry(scenario)).toMatchObject({ status: "ambiguous" });
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
