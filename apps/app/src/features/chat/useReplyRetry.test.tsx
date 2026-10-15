// @vitest-environment jsdom
/**
 * Failed-reply Retry: the new reply first, the server's replaces it by id, a
 * refusal notes the failed reply, and a request whose execution closed without
 * its reply retires, read from the run-state record at or after its answer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
const api = vi.hoisted(() => ({ retryReply: vi.fn() }));
vi.mock("@/client/api/threads-api", () => api);
const invalidateQueries = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries }) }));
const announcements = vi.hoisted(() => ({ announce: vi.fn(), announceError: vi.fn() }));
const view = vi.hoisted(() => ({ current: undefined as unknown, dispatchRunState: vi.fn() }));
vi.mock("@/client/stores", () => ({
  ...announcements,
  useThreadActions: () => view,
  useRunState: () => view.current,
}));

import type { Turn } from "@meridian/contracts/protocol";
import type { RunState } from "@meridian/contracts/threads";
import { INITIAL_RUN_STATE_VIEW, receiveRecord } from "@meridian/thread-client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HttpResponseError } from "@/client/api/http-client";
import { type ReplyRetry, useReplyRetry } from "./useReplyRetry";
import { RETRY_PENDING_ATTEMPTS } from "./useRetryStandIns";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function turn(id: string, role: Turn["role"], status: Turn["status"], position: number): Turn {
  return {
    id,
    threadId: "t",
    position,
    prevTurnId: null,
    role,
    status,
    writeMode: "direct",
    error: null,
    blocks: [],
  } as unknown as Turn;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const message = turn("u", "user", "complete", 1);
const failed = turn("f", "assistant", "error", 2);
/** The record the server held at `version`, with the open execution `executionId` (none when null). */
function record(version: string, executionId: string | null): RunState {
  return {
    version,
    items: [],
    sentThrough: 0,
    execution: executionId ? { executionId, currentTurnId: null } : null,
    mode: "direct",
    blocked: null,
  };
}
function hold(next: RunState | null) {
  view.current = next ? receiveRecord(INITIAL_RUN_STATE_VIEW, next) : INITIAL_RUN_STATE_VIEW;
}

let root: Root;
let latest: ReplyRetry;
function Probe({ turns }: { turns: readonly Turn[] }) {
  latest = useReplyRetry({ threadId: "t", storedTurns: turns });
  return null;
}

function retryPending(retryAfterSeconds?: number) {
  return new HttpResponseError(
    "retry_pending",
    503,
    null,
    retryAfterSeconds === undefined
      ? undefined
      : new Headers({ "Retry-After": String(retryAfterSeconds) }),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  hold(null);
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe turns={[message, failed]} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("useReplyRetry", () => {
  it("takes the server's reply from the response, then yields to the snapshot by id", async () => {
    api.retryReply.mockImplementation(
      async (_thread: string, _failed: string, { id }: { id: string }) => ({
        executionId: "execution-r",
        turn: turn(id, "assistant", "pending", 3),
      }),
    );
    await act(async () => latest.retry(failed));
    const id = latest.standIns[0]?.id ?? "";
    expect(latest.requestOf(id)).toBe("sent");
    expect(invalidateQueries).toHaveBeenCalled();
    await act(async () =>
      root.render(<Probe turns={[message, failed, turn(id, "assistant", "streaming", 3)]} />),
    );
    expect(latest.standIns).toEqual([]);
    expect(latest.requestOf(id)).toBeNull();
  });

  it("retires a stand-in whose execution closed with no reply, and keeps it until the record says so", async () => {
    api.retryReply.mockResolvedValueOnce({
      executionId: "e-r",
      turn: null,
      runState: record("2000", "e-r"),
    });
    await act(async () => latest.retry(failed));
    expect(latest.standIns).toHaveLength(1);

    // An older record, and the Retry's own execution still open: the reply may yet start.
    hold(record("1000", null));
    await act(async () => root.render(<Probe turns={[message, failed]} />));
    expect(latest.standIns).toHaveLength(1);
    hold(record("2001", "e-r"));
    await act(async () => root.render(<Probe turns={[message, failed]} />));
    expect(latest.standIns).toHaveLength(1);

    // At or past the answer, the execution is gone and the store has no reply: nothing will come.
    hold(record("2002", null));
    await act(async () => root.render(<Probe turns={[message, failed]} />));
    expect(latest.standIns).toEqual([]);
  });

  it("keeps a replayed Retry's stand-in until the replay answers, then retires it by that answer", async () => {
    vi.useFakeTimers();
    try {
      api.retryReply
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ executionId: "e-r", turn: null, runState: record("3000", "e-r") });
      await act(async () => latest.retry(failed));
      const lost = latest.standIns[0] as Turn;
      // The lost request has no answer version, so even an idle record cannot retire it.
      hold(record("3500", null));
      await act(async () => root.render(<Probe turns={[message, failed]} />));
      expect(latest.requestOf(lost.id)).toBe("failed");
      await act(async () => latest.retry(lost));
      expect(latest.standIns).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the new reply on a refusal (409), cards the failed reply until the next reply completes, and refreshes", async () => {
    api.retryReply.mockRejectedValue(new HttpResponseError("reply_retry_unavailable", 409, null));
    await act(async () => latest.retry(failed));
    expect(latest.standIns).toEqual([]);
    expect(latest.refused.has("f")).toBe(true);
    expect(invalidateQueries).toHaveBeenCalled();
    expect(announcements.announce).toHaveBeenCalledWith("Couldn't retry.");
    // The other reply is still running: the card stays. A reply that fails doesn't clear it.
    await act(async () =>
      root.render(<Probe turns={[message, failed, turn("o", "assistant", "streaming", 3)]} />),
    );
    expect(latest.refused.has("f")).toBe(true);
    await act(async () =>
      root.render(<Probe turns={[message, failed, turn("o", "assistant", "error", 3)]} />),
    );
    expect(latest.refused.has("f")).toBe(true);
    // A reply that completes after the refusal clears it, with no action from the writer.
    await act(async () =>
      root.render(<Probe turns={[message, failed, turn("o", "assistant", "complete", 3)]} />),
    );
    expect(latest.refused.has("f")).toBe(false);
    // Refused again, the writer's next Retry clears it while its request runs.
    await act(async () => latest.retry(failed));
    expect(latest.refused.has("f")).toBe(true);
    api.retryReply.mockReturnValueOnce(new Promise(() => undefined));
    await act(async () => latest.retry(turn("g", "assistant", "error", 4)));
    expect(latest.refused.has("f")).toBe(false);
  });

  it("keeps a lost request's reply, failed, and its Retry re-sends the same id for the same failed reply", async () => {
    api.retryReply.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => latest.retry(failed));
    const lost = latest.standIns[0] as Turn;
    expect(lost).toMatchObject({ status: "error", error: "Couldn't start the retry. Try again." });
    expect(latest.requestOf(lost.id)).toBe("failed");
    expect(announcements.announceError).toHaveBeenCalledWith(
      "Couldn't start the retry. Try again.",
    );
    api.retryReply.mockReturnValueOnce(deferred<Turn>().promise);
    await act(async () => latest.retry(lost));
    expect(api.retryReply).toHaveBeenLastCalledWith("t", "f", { id: lost.id });
    expect(latest.standIns).toHaveLength(1);
    expect(latest.standIns[0]).toMatchObject({ id: lost.id, status: "pending", error: null });
  });

  it("treats a replay the server can't place yet as pending, and keeps the stand-in once it answers the execution", async () => {
    vi.useFakeTimers();
    try {
      api.retryReply
        .mockRejectedValueOnce(retryPending())
        .mockResolvedValueOnce({ executionId: "execution-r", turn: null });
      await act(async () => latest.retry(failed));
      const id = latest.standIns[0]?.id ?? "";
      // Not a refusal and not lost: the same id goes again.
      expect(latest.refused.has("f")).toBe(false);
      expect(latest.requestOf(id)).toBe("sending");
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(api.retryReply).toHaveBeenCalledTimes(2);
      expect(api.retryReply).toHaveBeenLastCalledWith("t", "f", { id });
      // The replay found the execution before its reply: the stand-in waits for it.
      expect(latest.requestOf(id)).toBe("sent");
      expect(latest.standIns[0]).toMatchObject({ id, status: "pending" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits the server's Retry-After between pending answers", async () => {
    vi.useFakeTimers();
    try {
      api.retryReply
        .mockRejectedValueOnce(retryPending(2))
        .mockRejectedValueOnce(retryPending(3))
        .mockResolvedValueOnce({ executionId: "e-r", turn: null });
      await act(async () => latest.retry(failed));
      const id = latest.standIns[0]?.id ?? "";
      await act(async () => vi.advanceTimersByTimeAsync(1999));
      expect(api.retryReply).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(api.retryReply).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(2999));
      expect(api.retryReply).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(api.retryReply).toHaveBeenCalledTimes(3);
      expect(api.retryReply).toHaveBeenLastCalledWith("t", "f", { id });
      expect(latest.requestOf(id)).toBe("sent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling after its budget and leaves the same request unresolved and retryable", async () => {
    vi.useFakeTimers();
    try {
      api.retryReply.mockRejectedValue(retryPending(1));
      await act(async () => latest.retry(failed));
      const id = latest.standIns[0]?.id ?? "";
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(api.retryReply).toHaveBeenCalledTimes(RETRY_PENDING_ATTEMPTS);
      // Not refused: nothing says the server wrote nothing.
      expect(latest.refused.has("f")).toBe(false);
      expect(latest.requestOf(id)).toBe("failed");
      expect(latest.standIns[0]).toMatchObject({ id, status: "error" });

      api.retryReply.mockResolvedValueOnce({ executionId: "e-r", turn: null });
      await act(async () => latest.retry(latest.standIns[0] as Turn));
      expect(api.retryReply).toHaveBeenLastCalledWith("t", "f", { id });
      expect(latest.requestOf(id)).toBe("sent");
    } finally {
      vi.useRealTimers();
    }
  });
});
