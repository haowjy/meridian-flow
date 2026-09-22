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
import type { AGUIEvent } from "@meridian/contracts/protocol";
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

function interruptKey(): string {
  return `${THREAD}\u0000${TURN}\u0000${INTERRUPT}`;
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
});
