/** WS message dispatch contracts for interruption settlement and subscription replay.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Request-correlated socket settlement routing
 */
import type { MeridianError } from "@meridian/contracts/interrupt";
import type { WsServerMessage } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchWsServerMessage,
  type WsServerMessageDispatchDeps,
} from "./dispatch-ws-server-message";

function errorFrame(
  code: string,
  threadId = "thread-1",
  requestId?: string,
): Extract<WsServerMessage, { type: "error" }> {
  const error: MeridianError = {
    code,
    message: `frame: ${code}`,
    retryable: false,
    source: "system",
  };
  return { type: "error", kind: "error", error, threadId, requestId };
}

function makeDeps() {
  const onInterruptResponseError = vi.fn();
  const onThreadError = vi.fn();
  const onGlobalError = vi.fn();
  const onRequestError = vi.fn();
  const deps: WsServerMessageDispatchDeps = {
    toError: vi.fn((error) => Object.assign(new Error(error.message), { code: error.code })),
    dispatchSequencedEvent: vi.fn(),
    onSubscribed: vi.fn(),
    onRequestError,
    handleGap: vi.fn(),
    send: vi.fn(),
    onConnected: vi.fn(),
    onThreadError,
    onGlobalError,
    onInterruptResponseError,
  };
  return { deps, onInterruptResponseError, onThreadError, onGlobalError, onRequestError };
}

describe("dispatchWsServerMessage", () => {
  it.each([
    "interrupt_not_pending",
    "interrupt_correlation_mismatch",
  ])("routes %s to the interrupt settlement owner instead of dropping it", (code) => {
    const { deps, onInterruptResponseError, onThreadError, onGlobalError } = makeDeps();
    dispatchWsServerMessage(errorFrame(code), deps);
    expect(onInterruptResponseError).toHaveBeenCalledTimes(1);
    const [threadId, error] = onInterruptResponseError.mock.calls[0] as [string, Error];
    expect(threadId).toBe("thread-1");
    expect(error).toBe(vi.mocked(deps.toError).mock.results[0].value);
    expect((error as unknown as { code: string }).code).toBe(code);
    expect(onThreadError).not.toHaveBeenCalled();
    expect(onGlobalError).not.toHaveBeenCalled();
  });

  it("still routes unrelated error frames to the thread error sink", () => {
    const { deps, onInterruptResponseError, onThreadError } = makeDeps();
    dispatchWsServerMessage(errorFrame("internal"), deps);
    expect(onInterruptResponseError).not.toHaveBeenCalled();
    expect(onThreadError).toHaveBeenCalledWith("thread-1", expect.any(Error));
  });

  it("routes an error naming a request to the request, but an interrupt refusal never", () => {
    const { deps, onRequestError, onInterruptResponseError, onThreadError } = makeDeps();
    dispatchWsServerMessage(errorFrame("internal", "thread-1", "r7"), deps);
    expect(onRequestError).toHaveBeenCalledWith("r7", expect.any(Error), false);
    dispatchWsServerMessage(errorFrame("interrupt_not_pending", "thread-1", "r8"), deps);
    expect(onRequestError).toHaveBeenCalledTimes(1);
    expect(onInterruptResponseError).toHaveBeenCalledTimes(1);
    expect(onThreadError).not.toHaveBeenCalled();
  });
});
