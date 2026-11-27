// @vitest-environment jsdom
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
const refusedFor = (turnId: string) =>
  latest.outcomes.some((outcome) => outcome.kind === "refused" && outcome.turnId === turnId);
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

    hold(record("1000", null));
    await act(async () => root.render(<Probe turns={[message, failed]} />));
    expect(latest.standIns).toHaveLength(1);
    hold(record("2001", "e-r"));
    await act(async () => root.render(<Probe turns={[message, failed]} />));
    expect(latest.standIns).toHaveLength(1);

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
      const id = latest.outcomes[0]?.requestId ?? "";
      hold(record("3500", null));
      await act(async () => root.render(<Probe turns={[message, failed]} />));
      expect(latest.outcomes).toMatchObject([{ kind: "lost", requestId: id }]);
      await act(async () => latest.retry(failed));
      expect(latest.standIns).toEqual([]);
      expect(latest.outcomes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the new reply on a refusal (409), cards the failed reply until the next reply completes, and refreshes", async () => {
    api.retryReply.mockRejectedValue(new HttpResponseError("reply_retry_unavailable", 409, null));
    await act(async () => latest.retry(failed));
    expect(latest.standIns).toEqual([]);
    expect(refusedFor("f")).toBe(true);
    expect(invalidateQueries).toHaveBeenCalled();
    await act(async () =>
      root.render(<Probe turns={[message, failed, turn("o", "assistant", "streaming", 3)]} />),
    );
    expect(refusedFor("f")).toBe(true);
    await act(async () =>
      root.render(<Probe turns={[message, failed, turn("o", "assistant", "error", 3)]} />),
    );
    expect(refusedFor("f")).toBe(true);
    await act(async () =>
      root.render(<Probe turns={[message, failed, turn("o", "assistant", "complete", 3)]} />),
    );
    expect(refusedFor("f")).toBe(false);
    await act(async () => latest.retry(failed));
    expect(refusedFor("f")).toBe(true);
    api.retryReply.mockReturnValueOnce(new Promise(() => undefined));
    await act(async () => latest.retry(turn("g", "assistant", "error", 4)));
    expect(refusedFor("f")).toBe(false);
  });

  it("keeps a lost request's reply, failed, and its Retry re-sends the same id for the same failed reply", async () => {
    api.retryReply.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => latest.retry(failed));
    expect(latest.standIns).toEqual([]);
    expect(latest.retried.size).toBe(0);
    const [outcome] = latest.outcomes;
    expect(outcome).toMatchObject({ kind: "lost", turnId: "f", attempt: 1 });
    expect(announcements.announceError).not.toHaveBeenCalled();
    api.retryReply.mockReturnValueOnce(deferred<Turn>().promise);
    await act(async () => latest.retry(failed));
    expect(api.retryReply).toHaveBeenLastCalledWith("t", "f", { id: outcome?.requestId });
    expect(latest.standIns).toHaveLength(1);
    expect(latest.standIns[0]).toMatchObject({ id: outcome?.requestId, status: "pending" });
    expect(latest.outcomes).toEqual([]);
  });

  it("treats a replay the server can't place yet as pending, and keeps the stand-in once it answers the execution", async () => {
    vi.useFakeTimers();
    try {
      api.retryReply
        .mockRejectedValueOnce(retryPending())
        .mockResolvedValueOnce({ executionId: "execution-r", turn: null });
      await act(async () => latest.retry(failed));
      const id = latest.standIns[0]?.id ?? "";
      expect(refusedFor("f")).toBe(false);
      expect(latest.requestOf(id)).toBe("sending");
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(api.retryReply).toHaveBeenCalledTimes(2);
      expect(api.retryReply).toHaveBeenLastCalledWith("t", "f", { id });
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
      expect(refusedFor("f")).toBe(false);
      expect(latest.outcomes).toMatchObject([{ kind: "lost", turnId: "f", requestId: id }]);

      api.retryReply.mockResolvedValueOnce({ executionId: "e-r", turn: null });
      await act(async () => latest.retry(failed));
      expect(api.retryReply).toHaveBeenLastCalledWith("t", "f", { id });
      expect(latest.requestOf(id)).toBe("sent");
    } finally {
      vi.useRealTimers();
    }
  });
});
