// @vitest-environment jsdom
/**
 * Failed-reply Retry: the new reply first, the server's replaces it by id, a
 * refusal notes the failed reply, and a request whose execution ended without
 * its reply (matched by execution or by `metadata.retryReplyId`) retires.
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
vi.mock("@/client/stores", () => announcements);

import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HttpResponseError } from "@/client/api/http-client";
import { EMPTY_RUN_FACTS, type RunFacts } from "@/client/copilot/run-follow";
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
/** An applied mode switch after the failed reply: Retry still answers past it. */
const modeSwitch = turn("s", "system", "complete", 3);

/** A compaction in execution `e`, reserved first by the Retry request `requestId`. */
function compaction(status: Turn["status"], requestId: string | null, executionId = "e-r") {
  return {
    ...turn("c", "compaction", status, 4),
    prevTurnId: "s",
    executionId,
    metadata: requestId ? { retryOf: "f", retryReplyId: requestId } : null,
  } as Turn;
}

/** The thread's run facts as the controller would have merged them. */
let facts: RunFacts = EMPTY_RUN_FACTS;
function endExecution(executionId: string) {
  facts = { ...facts, ended: new Set(facts.ended).add(executionId) };
}
const runFacts = () => facts;

let root: Root;
let latest: ReplyRetry;
function Probe({ turns }: { turns: readonly Turn[] }) {
  latest = useReplyRetry({ threadId: "t", storedTurns: turns, runFacts });
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
  facts = EMPTY_RUN_FACTS;
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

  it("retires a reply whose answered execution ends on a stopped compaction", async () => {
    api.retryReply.mockResolvedValueOnce({ executionId: "e-r", turn: null });
    await act(async () => latest.retry(failed));
    const id = latest.standIns[0]?.id ?? "";
    await act(async () =>
      root.render(<Probe turns={[message, failed, modeSwitch, compaction("streaming", null)]} />),
    );
    expect(latest.standIns).toHaveLength(1);

    endExecution("e-r");
    await act(async () =>
      root.render(<Probe turns={[message, failed, modeSwitch, compaction("cancelled", null)]} />),
    );
    expect(latest.standIns).toEqual([]);
    expect(latest.requestOf(id)).toBeNull();
  });

  it("F, a switch S, then a cancelled compaction C: a lost Retry retires by the request id C records", async () => {
    api.retryReply.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => latest.retry(failed));
    const lost = latest.standIns[0] as Turn;
    expect(latest.requestOf(lost.id)).toBe("failed");

    // C's predecessor is S, not F: only the request id ties C to this Retry.
    await act(async () =>
      root.render(
        <Probe turns={[message, failed, modeSwitch, compaction("streaming", lost.id)]} />,
      ),
    );
    expect(latest.standIns).toHaveLength(1);
    endExecution("e-r");
    await act(async () =>
      root.render(
        <Probe turns={[message, failed, modeSwitch, compaction("cancelled", lost.id)]} />,
      ),
    );
    expect(latest.standIns).toEqual([]);
    expect(latest.requestOf(lost.id)).toBeNull();
  });

  it("F, S, C after a null replay: the replay's execution retires the stand-in", async () => {
    vi.useFakeTimers();
    try {
      api.retryReply
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ executionId: "e-r", turn: null });
      await act(async () => latest.retry(failed));
      const lost = latest.standIns[0] as Turn;
      await act(async () => latest.retry(lost));
      expect(latest.requestOf(lost.id)).toBe("sent");
      endExecution("e-r");
      await act(async () =>
        root.render(<Probe turns={[message, failed, modeSwitch, compaction("cancelled", null)]} />),
      );
      expect(latest.standIns).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a stand-in when an unrelated compaction ends next to its failed reply", async () => {
    api.retryReply.mockResolvedValueOnce({ executionId: "e-r", turn: null });
    await act(async () => latest.retry(failed));
    endExecution("e-other");
    await act(async () =>
      root.render(
        <Probe
          turns={[
            message,
            failed,
            { ...compaction("cancelled", null, "e-other"), prevTurnId: failed.id },
          ]}
        />,
      ),
    );
    expect(latest.standIns).toHaveLength(1);
  });

  it("keeps a stand-in whose execution ended after starting it, until the store has the reply", async () => {
    api.retryReply.mockResolvedValueOnce({ executionId: "e-r", turn: null });
    await act(async () => latest.retry(failed));
    const id = latest.standIns[0]?.id ?? "";
    facts = {
      ...facts,
      turns: new Map([[id, { executionId: "e-r", reservedForUserTurnIds: [], position: 3 }]]),
    };
    endExecution("e-r");
    await act(async () => root.render(<Probe turns={[message, failed, modeSwitch]} />));
    expect(latest.standIns).toHaveLength(1);
  });

  it("drops the new reply on a refusal (409), notes the failed reply, and refreshes", async () => {
    api.retryReply.mockRejectedValue(new HttpResponseError("reply_retry_unavailable", 409, null));
    await act(async () => latest.retry(failed));
    expect(latest.standIns).toEqual([]);
    expect(latest.refused.has("f")).toBe(true);
    expect(invalidateQueries).toHaveBeenCalled();
    expect(announcements.announce).toHaveBeenCalledWith("Couldn't retry.");
    // Pressing Retry again clears the note while the new request runs.
    api.retryReply.mockReturnValueOnce(new Promise(() => undefined));
    await act(async () => latest.retry(failed));
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
