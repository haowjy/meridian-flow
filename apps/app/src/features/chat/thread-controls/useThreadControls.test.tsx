// @vitest-environment jsdom
/** `/compact` dispatch: optimistic at once, retried with the same id, withdrawn at once on both sides. */
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
vi.mock("@/client/query/write-mode-cache", () => ({ applyWriteModeAnswer: vi.fn() }));
const announcements = vi.hoisted(() => ({ announce: vi.fn(), announceError: vi.fn() }));
vi.mock("@/client/stores", () => announcements);

import type { Turn } from "@meridian/contracts/protocol";
import type { ThreadPendingInbox } from "@meridian/contracts/threads";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HttpResponseError } from "@/client/api/http-client";
import type { JournalSwitch } from "@/client/chat-submissions/owner";
import { useControlTurnAnnouncements } from "../compaction/useControlTurnAnnouncements";
import type { QueuedControl } from "./thread-controls";
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
const NO_JOURNAL = {
  pending: [],
  submit: () => true,
  retry: () => undefined,
  withdraw: () => Promise.resolve("admitted" as const),
  settle: () => undefined,
  onAnswered: () => () => undefined,
};
const NONE: ReadonlySet<string> = new Set();

let root: Root;
let latest: ThreadControls;
function Probe(props: {
  pending?: ThreadPendingInbox;
  journaled?: readonly JournalSwitch[];
  turns?: readonly Turn[];
  answered?: ReadonlySet<string>;
}) {
  latest = useThreadControls({
    threadId: "thread-1",
    projectId: "project-1",
    writeMode: "direct",
    pending: props.pending ?? EMPTY,
    answeredControlIds: props.answered ?? NONE,
    switches: { ...NO_JOURNAL, pending: props.journaled ?? [] },
  });
  useControlTurnAnnouncements(props.turns ?? []);
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
    expect(latest.queued).toEqual([{ id, control: { kind: "compact" }, status: "sending" }]);
    expect(announcements.announce).toHaveBeenCalledWith("Compaction queued");
    await act(async () => response.resolve({ id, pending: null, turnId: "c" }));
    expect(latest.queued).toEqual([]);
    expect(invalidateQueries).toHaveBeenCalled();
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

  it("withdraws on the server when the enqueue response was lost but the server has the row", async () => {
    // The request reached the server; only its response was lost.
    api.enqueueThreadControl.mockRejectedValue(new TypeError("Failed to fetch"));
    api.withdrawThreadControl.mockResolvedValue({ outcome: "withdrawn" });
    let id = "";
    await act(async () => {
      id = latest.enqueue({ kind: "compact" });
    });
    expect(latest.queued).toEqual([{ id, control: { kind: "compact" }, status: "failed" }]);
    const serverRow: ThreadPendingInbox = {
      items: [
        {
          id,
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
    const [failed] = latest.queued;
    if (!failed) throw new Error("expected a failed control");
    await act(async () => latest.withdraw(failed));
    expect(api.withdrawThreadControl).toHaveBeenCalledWith("thread-1", id);
    expect(latest.queued).toEqual([]);
    // A lagging inbox frame still lists it, then the server drops it.
    await act(async () => root.render(<Probe pending={serverRow} />));
    expect(latest.queued).toEqual([]);
    await act(async () => root.render(<Probe />));
    expect(latest.queued).toEqual([]);
    expect(announcements.announceError).not.toHaveBeenCalledWith("Couldn't withdraw. Try again.");
  });

  it("withdraws on the server once a failed in-flight enqueue settles, and a 404 drops the row", async () => {
    const enqueued = deferred<unknown>();
    api.enqueueThreadControl.mockReturnValue(enqueued.promise);
    api.withdrawThreadControl.mockRejectedValue(
      new HttpResponseError("control_not_found", 404, null),
    );
    let id = "";
    await act(async () => {
      id = latest.enqueue({ kind: "compact" });
    });
    const [queued] = latest.queued;
    if (!queued) throw new Error("expected a queued control");
    await act(async () => latest.withdraw(queued));
    expect(api.withdrawThreadControl).not.toHaveBeenCalled();
    await act(async () => enqueued.reject(new TypeError("Failed to fetch")));
    expect(api.withdrawThreadControl).toHaveBeenCalledWith("thread-1", id);
    expect(latest.queued).toEqual([]);
    expect(announcements.announceError).not.toHaveBeenCalled();
  });

  it("shows the row again, queued, when the server lists a command its withdrawal 404ed", async () => {
    // The enqueue was still being committed when Withdraw reached the server.
    api.enqueueThreadControl.mockRejectedValue(new TypeError("Failed to fetch"));
    api.withdrawThreadControl.mockRejectedValue(
      new HttpResponseError("control_not_found", 404, null),
    );
    let id = "";
    await act(async () => {
      id = latest.enqueue({ kind: "compact" });
    });
    const [failed] = latest.queued;
    if (!failed) throw new Error("expected a failed control");
    await act(async () => latest.withdraw(failed));
    expect(latest.queued).toEqual([]);
    const committed: ThreadPendingInbox = {
      items: [
        {
          id,
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
    await act(async () => root.render(<Probe pending={committed} />));
    expect(latest.queued).toEqual([{ id, control: { kind: "compact" }, status: "queued" }]);
  });

  it("announces a switch as it queues and as it applies, and nothing for a switch back", async () => {
    const inbox = (id: string, mode: "draft" | "direct"): ThreadPendingInbox => ({
      items: [
        {
          id,
          seq: 1,
          intent: "control",
          control: { kind: "write_mode", mode },
          provenance: { kind: "writer", actorId: "w" },
          deliveryState: "waiting",
          summary: "",
          enqueuedAt: "2026-09-28T00:00:00.000Z",
        },
      ],
    });
    const turn = (id: string, position: number, metadata: Turn["metadata"] = null) =>
      ({
        id,
        threadId: "thread-1",
        position,
        role: metadata ? "system" : "user",
        status: "complete",
        blocks: [],
        metadata,
      }) as unknown as Turn;
    const history = [turn("u", 0)];
    const sending = [{ id: "s1", mode: "draft", failed: false, awaitingServer: false }] as const;
    await act(async () => root.render(<Probe journaled={sending} turns={history} />));
    expect(announcements.announce).not.toHaveBeenCalled();
    // The server answers: queued behind a reply.
    await act(async () => root.render(<Probe pending={inbox("s1", "draft")} turns={history} />));
    expect(announcements.announce).toHaveBeenLastCalledWith("Switch to draft mode queued");
    expect(latest.writeMode).toBe("draft");
    // Its divider lands: the applied state.
    const divider = turn("sw", 1, {
      kind: "write_mode_switch",
      mode: "draft",
      controlMessageId: "s1",
    });
    await act(async () =>
      root.render(<Probe turns={[...history, divider]} answered={new Set(["s1"])} />),
    );
    expect(announcements.announce).toHaveBeenLastCalledWith("Switched to draft mode");
    announcements.announce.mockClear();
    // A queued auto-apply switch, and a switch back to draft before the server answers: both vanish.
    await act(async () =>
      root.render(
        <Probe
          pending={inbox("s2", "direct")}
          journaled={[{ id: "s3", mode: "draft", failed: false, awaitingServer: false }]}
          turns={[...history, divider]}
        />,
      ),
    );
    expect(latest.queued).toEqual([]);
    expect(announcements.announce).not.toHaveBeenCalled();
    expect(announcements.announceError).not.toHaveBeenCalled();
  });

  it("stops a pending divider through the cancel route and marks it stopping", async () => {
    transport.cancel.mockResolvedValue({ status: "cancelled" });
    await act(async () => latest.stop("c"));
    expect(transport.cancel).toHaveBeenCalledWith("thread-1", "c");
    expect(latest.stoppingTurnIds.has("c")).toBe(true);
    expect(invalidateQueries).toHaveBeenCalled();
  });

  it("drops the row and says so when Withdraw comes after the compaction started", async () => {
    api.withdrawThreadControl.mockResolvedValue({ outcome: "already_started" });
    await act(async () =>
      latest.withdraw({
        id: "k",
        control: { kind: "compact" },
        status: "queued",
      }),
    );
    expect(announcements.announce).toHaveBeenLastCalledWith("This compaction already started.");
    expect(latest.queued).toEqual([]);
  });
});
