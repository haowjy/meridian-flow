// @vitest-environment jsdom
/** `/compact` and Undo dispatch: optimistic at once, retried with the same id, withdrawn in place. */
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
    expect(announcements.announce).toHaveBeenCalledWith("Compaction queued");
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

  it("waits for an in-flight enqueue before withdrawing, then lands the outcome", async () => {
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
    expect(latest.queued[0]?.status).toBe("withdrawing");
    expect(announcements.announce).toHaveBeenLastCalledWith("Withdrawing compaction");
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
    expect(latest.queued[0]?.status).toBe("withdrawn");
    expect(announcements.announce).toHaveBeenLastCalledWith("Compaction withdrawn");
    // The outcome stays until the transcript moves on.
    await act(async () => root.render(<Probe leaf="leaf-2" />));
    expect(latest.queued).toEqual([]);
  });

  it("queues Undo for a divider", async () => {
    api.enqueueThreadControl.mockReturnValue(new Promise(() => undefined));
    await act(async () => {
      latest.enqueue({ kind: "compaction_undo", compactionTurnId: "c" });
    });
    expect(latest.queued[0]).toMatchObject({
      control: { kind: "compaction_undo", compactionTurnId: "c" },
      status: "queued",
    });
    expect(announcements.announce).toHaveBeenCalledWith("Undo queued");
  });

  it("stops a pending divider through the cancel route and marks it stopping", async () => {
    transport.cancel.mockResolvedValue({ status: "cancelled" });
    await act(async () => latest.stop("c"));
    expect(transport.cancel).toHaveBeenCalledWith("thread-1", "c");
    expect(latest.stoppingTurnIds.has("c")).toBe(true);
    expect(invalidateQueries).toHaveBeenCalled();
  });

  it("announces a failed enqueue in its own control kind's words", async () => {
    api.enqueueThreadControl.mockRejectedValue(new Error("offline"));
    await act(async () => {
      latest.enqueue({ kind: "handoff_brief" });
    });
    expect(announcements.announceError).toHaveBeenLastCalledWith(
      "Couldn't queue the handoff brief.",
    );
    await act(async () => {
      latest.enqueue({ kind: "compaction_undo", compactionTurnId: "c" });
    });
    expect(announcements.announceError).toHaveBeenLastCalledWith("Couldn't queue the undo.");
  });

  it("announces the same words the row shows when a withdrawal finds the control already ran", async () => {
    api.enqueueThreadControl.mockResolvedValue({ id: "x", pending: null, turnId: null });
    api.withdrawThreadControl.mockResolvedValue({ outcome: "already_finished" });
    await act(async () =>
      latest.withdraw({ id: "k", control: { kind: "compact" }, status: "queued" }),
    );
    expect(announcements.announce).toHaveBeenLastCalledWith("This compaction already ran.");
  });
});
