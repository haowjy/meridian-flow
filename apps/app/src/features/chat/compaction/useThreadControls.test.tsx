// @vitest-environment jsdom
/** `/compact` dispatch: optimistic at once, retried with the same id, withdrawn at once. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
const api = vi.hoisted(() => ({
  enqueueThreadControl: vi.fn(),
  withdrawThreadControl: vi.fn(),
}));
vi.mock("@/client/api/threads-api", () => api);
const transport = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock("@/client/providers/TransportProvider", () => ({ useThreadTransport: () => transport }));
const invalidateQueries = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries }) }));
const announcements = vi.hoisted(() => ({ announce: vi.fn(), announceError: vi.fn() }));
vi.mock("@/client/stores", () => announcements);

import type { ThreadPendingInbox } from "@meridian/contracts/threads";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HttpResponseError } from "@/client/api/http-client";
import { type ThreadControls, useThreadControls } from "./useThreadControls";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const EMPTY: ThreadPendingInbox = { items: [] };
const NONE: ReadonlySet<string> = new Set();

let root: Root;
let latest: ThreadControls;
function Probe(props: { pending?: ThreadPendingInbox; leaf?: string }) {
  latest = useThreadControls({
    threadId: "thread-1",
    pending: props.pending ?? EMPTY,
    answeredControlIds: NONE,
    leafTurnId: props.leaf ?? "leaf-1",
  });
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("useThreadControls", () => {
  it("shows /compact as queued before the server answers, with a client-minted id", async () => {
    const response = deferred<unknown>();
    api.enqueueThreadControl.mockReturnValue(response.promise);
    let id = "";
    await act(async () => {
      id = latest.enqueue({ kind: "compact" });
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.enqueueThreadControl).toHaveBeenCalledWith("thread-1", {
      id,
      control: { kind: "compact" },
    });
    expect(latest.queued).toEqual([{ id, control: { kind: "compact" }, status: "queued" }]);
    expect(announcements.announce).toHaveBeenCalledWith(
      "Compaction queued. Runs when replies finish.",
    );
    await act(async () => response.resolve({ id, pending: null, turnId: "c" }));
    expect(latest.queued).toEqual([]);
    expect(invalidateQueries).toHaveBeenCalled();
  });

  it("keeps a failed enqueue on the item and retries it with the same id", async () => {
    api.enqueueThreadControl.mockRejectedValueOnce(new Error("offline"));
    let id = "";
    await act(async () => {
      id = latest.enqueue({ kind: "compact" });
    });
    expect(latest.queued).toEqual([{ id, control: { kind: "compact" }, status: "failed" }]);
    expect(announcements.announceError).toHaveBeenCalledWith("Couldn't queue the compaction.");
    const retry = deferred<unknown>();
    api.enqueueThreadControl.mockReturnValueOnce(retry.promise);
    await act(async () => latest.retry(id));
    expect(api.enqueueThreadControl).toHaveBeenLastCalledWith("thread-1", {
      id,
      control: { kind: "compact" },
    });
    expect(latest.queued[0]?.status).toBe("queued");
  });

  it("removes the row at once, and withdraws once the in-flight enqueue lands", async () => {
    const enqueued = deferred<unknown>();
    api.enqueueThreadControl.mockReturnValue(enqueued.promise);
    api.withdrawThreadControl.mockResolvedValue({ outcome: "withdrawn" });
    let id = "";
    await act(async () => {
      id = latest.enqueue({ kind: "compact" });
    });
    const [queued] = latest.queued;
    if (!queued) throw new Error("expected a queued control");
    await act(async () => latest.withdraw(queued));
    expect(api.withdrawThreadControl).not.toHaveBeenCalled();
    expect(latest.queued).toEqual([]);
    expect(announcements.announce).toHaveBeenLastCalledWith("Compaction withdrawn");
    await act(async () =>
      enqueued.resolve({
        id,
        pending: {
          id,
          seq: 1,
          intent: "control",
          control: { kind: "compact" },
          provenance: { kind: "writer", actorId: "w" },
          deliveryState: "awaiting_run",
          summary: "Compact conversation",
          enqueuedAt: "2026-09-28T00:00:00.000Z",
        },
        turnId: null,
      }),
    );
    expect(api.withdrawThreadControl).toHaveBeenCalledWith("thread-1", id);
    expect(latest.queued).toEqual([]);
  });

  it("withdraws locally when the in-flight enqueue fails: no request, no failure", async () => {
    const enqueued = deferred<unknown>();
    api.enqueueThreadControl.mockReturnValue(enqueued.promise);
    await act(async () => {
      latest.enqueue({ kind: "compact" });
    });
    const [queued] = latest.queued;
    if (!queued) throw new Error("expected a queued control");
    await act(async () => latest.withdraw(queued));
    await act(async () => enqueued.reject(new TypeError("Failed to fetch")));
    expect(api.withdrawThreadControl).not.toHaveBeenCalled();
    expect(latest.queued).toEqual([]);
    expect(announcements.announceError).not.toHaveBeenCalled();
  });

  it("counts a 404 on an id the inbox never listed as withdrawn", async () => {
    api.enqueueThreadControl.mockImplementation(
      async (_thread: string, { id }: { id: string }) => ({
        id,
        pending: null,
        turnId: null,
      }),
    );
    api.withdrawThreadControl.mockRejectedValue(
      new HttpResponseError("control_not_found", 404, null),
    );
    await act(async () => {
      latest.enqueue({ kind: "compact" });
    });
    const queued = { id: "", control: { kind: "compact" }, status: "queued" } as const;
    const id = api.enqueueThreadControl.mock.calls[0]?.[1].id as string;
    await act(async () => latest.withdraw({ ...queued, id }));
    expect(api.withdrawThreadControl).toHaveBeenCalledWith("thread-1", id);
    expect(latest.queued).toEqual([]);
    expect(announcements.announceError).not.toHaveBeenCalled();
  });

  it("still fails a 404 on a command the inbox listed", async () => {
    api.withdrawThreadControl.mockRejectedValue(
      new HttpResponseError("control_not_found", 404, null),
    );
    await act(async () =>
      latest.withdraw({ id: "k", control: { kind: "compact" }, status: "queued" }),
    );
    expect(announcements.announceError).toHaveBeenCalledWith("Couldn't withdraw. Try again.");
  });

  it("brings the row back when the withdrawal fails", async () => {
    api.withdrawThreadControl.mockRejectedValue(new Error("offline"));
    const queued = { id: "k", control: { kind: "compact" }, status: "queued" } as const;
    const inbox: ThreadPendingInbox = {
      items: [
        {
          id: "k",
          seq: 1,
          intent: "control",
          control: { kind: "compact" },
          provenance: { kind: "writer", actorId: "w" },
          deliveryState: "awaiting_run",
          summary: "Compact conversation",
          enqueuedAt: "2026-09-28T00:00:00.000Z",
        },
      ],
    };
    await act(async () => root.render(<Probe pending={inbox} />));
    await act(async () => latest.withdraw(queued));
    expect(latest.queued).toEqual([{ ...queued, status: "withdraw_failed" }]);
    expect(announcements.announceError).toHaveBeenCalledWith("Couldn't withdraw. Try again.");
  });

  it("stops a pending divider through the cancel route and marks it stopping", async () => {
    transport.cancel.mockResolvedValue({ status: "cancelled" });
    await act(async () => latest.stop("c"));
    expect(transport.cancel).toHaveBeenCalledWith("thread-1", "c");
    expect(latest.stoppingTurnIds.has("c")).toBe(true);
    expect(invalidateQueries).toHaveBeenCalled();
  });

  it("says so when a Stop on the divider fails, and gives Stop back", async () => {
    transport.cancel.mockRejectedValueOnce(new Error("offline"));
    await act(async () => latest.stop("c"));
    expect(announcements.announce).toHaveBeenCalledWith("Stopping compaction");
    expect(announcements.announceError).toHaveBeenCalledWith(
      "Couldn't stop the compaction. Try again.",
    );
    expect(latest.stoppingTurnIds.has("c")).toBe(false);
  });

  it("announces a failed enqueue", async () => {
    api.enqueueThreadControl.mockRejectedValue(new Error("offline"));
    await act(async () => {
      latest.enqueue({ kind: "compact" });
    });
    expect(announcements.announceError).toHaveBeenLastCalledWith("Couldn't queue the compaction.");
  });

  it("says a command already started when Withdraw comes too late", async () => {
    api.withdrawThreadControl.mockResolvedValue({ outcome: "already_started" });
    await act(async () =>
      latest.withdraw({ id: "k", control: { kind: "compact" }, status: "queued" }),
    );
    expect(announcements.announce).toHaveBeenLastCalledWith("This compaction already started.");
    expect(latest.queued).toEqual([
      { id: "k", control: { kind: "compact" }, status: "already_started" },
    ]);
  });
});
