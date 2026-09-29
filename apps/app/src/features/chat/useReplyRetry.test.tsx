// @vitest-environment jsdom
/** Failed-reply Retry: the new reply first, the server's replaces it by id, a refusal notes the failed reply. */
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
import { type ReplyRetry, useReplyRetry } from "./useReplyRetry";

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

let root: Root;
let latest: ReplyRetry;
function Probe({ turns }: { turns: readonly Turn[] }) {
  latest = useReplyRetry({ threadId: "t", storedTurns: turns });
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe turns={[message, failed]} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("useReplyRetry", () => {
  it("shows a working reply below the failed one before the server answers, under a client-minted id", async () => {
    api.retryReply.mockReturnValue(deferred<Turn>().promise);
    await act(async () => latest.retry(failed));
    const [reply] = latest.standIns;
    expect(reply).toMatchObject({
      role: "assistant",
      status: "pending",
      position: 3,
      prevTurnId: "f",
      writeMode: "direct",
    });
    expect(reply?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.retryReply).toHaveBeenCalledWith("t", "f", { id: reply?.id });
    expect(latest.requestOf(reply?.id ?? "")).toBe("sending");
  });

  it("takes the server's reply from the response, then yields to the snapshot by id", async () => {
    api.retryReply.mockImplementation(
      async (_thread: string, _failed: string, { id }: { id: string }) =>
        turn(id, "assistant", "pending", 3),
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

  it("drops a promised reply when its compaction is stopped without creating it", async () => {
    api.retryReply.mockImplementation(
      async (_thread: string, _failed: string, { id }: { id: string }) => ({
        ...turn(id, "assistant", "pending", 4),
        prevTurnId: "c",
      }),
    );
    await act(async () => latest.retry(failed));
    const id = latest.standIns[0]?.id ?? "";
    await act(async () =>
      root.render(<Probe turns={[message, failed, turn("c", "compaction", "streaming", 3)]} />),
    );
    expect(latest.standIns).toHaveLength(1);

    await act(async () =>
      root.render(<Probe turns={[message, failed, turn("c", "compaction", "cancelled", 3)]} />),
    );
    expect(latest.standIns).toEqual([]);
    expect(latest.requestOf(id)).toBeNull();
  });

  it("drops the new reply on a refusal (409), notes the failed reply, and refreshes", async () => {
    api.retryReply.mockRejectedValue(new HttpResponseError("reply_retry_unavailable", 409, null));
    await act(async () => latest.retry(failed));
    expect(latest.standIns).toEqual([]);
    expect(latest.refused.has("f")).toBe(true);
    expect(invalidateQueries).toHaveBeenCalled();
    expect(announcements.announce).toHaveBeenCalledWith(
      "Couldn't retry. Something else started in this chat first.",
    );
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

  it("drops a lost Retry's reply when its re-send is refused, noting the failed reply", async () => {
    api.retryReply.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => latest.retry(failed));
    const lost = latest.standIns[0] as Turn;
    api.retryReply.mockRejectedValueOnce(
      new HttpResponseError("reply_retry_unavailable", 409, null),
    );
    await act(async () => latest.retry(lost));
    expect(latest.standIns).toEqual([]);
    expect([...latest.refused]).toEqual(["f"]);
  });
});
