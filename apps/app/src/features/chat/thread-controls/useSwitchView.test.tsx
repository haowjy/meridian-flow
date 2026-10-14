// @vitest-environment jsdom
/**
 * The view's shell with real React and an injected API, transport and journal: what Stop
 * announces, and when; how the record's delivery state words a pending switch; and when a
 * change in the record's switches marks the Works reads stale. The display itself is
 * `switch-view.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
const api = vi.hoisted(() => ({ withdrawThreadControl: vi.fn() }));
vi.mock("@/client/api/threads-api", () => api);
const announcements = vi.hoisted(() => ({ announce: vi.fn(), announceError: vi.fn() }));
const slices = vi.hoisted(() => ({
  feed: (_action: unknown) => undefined as void,
  reset: () => undefined as void,
}));
// The chat's slice is the thread store's; here a one-chat stand-in over the real reducer.
vi.mock("@/client/stores", async () => {
  const { INITIAL_RUN_STATE_SLICE, reduceRunState } = await import(
    "@/client/run-state/run-state-slice"
  );
  const { useSyncExternalStore } = await import("react");
  let slice = INITIAL_RUN_STATE_SLICE;
  const listeners = new Set<() => void>();
  const actions = {
    dispatchRunState: (_threadId: string, action: Parameters<typeof reduceRunState>[1]) => {
      slice = reduceRunState(slice, action);
      for (const listener of listeners) listener();
    },
  };
  slices.feed = (action) => actions.dispatchRunState("T", action as never);
  slices.reset = () => {
    slice = INITIAL_RUN_STATE_SLICE;
  };
  return {
    ...announcements,
    useThreadActions: () => actions,
    useRunStateSlice: () =>
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => slice,
      ),
  };
});
vi.mock("@/client/query/project-invalidation", () => ({
  invalidateProjectThreadData: vi.fn(),
  invalidateWriteModeReads: vi.fn(),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HttpResponseError } from "@/client/api/http-client";
import { invalidateWriteModeReads } from "@/client/query/project-invalidation";
import { type SwitchJournal, type SwitchView, useSwitchView } from "./useSwitchView";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const record = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  mode: "draft" as const,
  seq: 1,
  posted: false,
  refused: false,
  failed: false,
  answer: null,
  ...over,
});

let root: Root;
let client: QueryClient;
let view: SwitchView;
let records: ReturnType<typeof record>[] = [];
let withdrawOutcome: "removed" | "admitted" | "kept" = "removed";
let repaint: () => void = () => undefined;
let replyRunning = false;

function Probe() {
  const [, render] = React.useReducer((n: number) => n + 1, 0);
  repaint = render;
  const journal: SwitchJournal = {
    pending: records as unknown as SwitchJournal["pending"],
    submit: () => true,
    retry: () => undefined,
    withdraw: async () => withdrawOutcome,
  };
  view = useSwitchView({
    threadId: "T",
    projectId: "P",
    writeMode: "direct",
    journal,
    replyRunning,
  });
  return null;
}

import * as React from "react";

const tick = (ms = 20) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const show = async (next: typeof records) => {
  records = next;
  await act(async () => repaint());
};

beforeEach(() => {
  vi.clearAllMocks();
  records = [];
  replyRunning = false;
  slices.reset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
});

it("announces a Stop only once its outcome is known", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  const cases: [string, "removed" | "admitted" | "kept", unknown, string[]][] = [
    ["w1", "removed", undefined, ["say:withdrawn"]],
    [
      "w2",
      "admitted",
      {
        outcome: "withdrawn",
        seq: "1999",
        pending: null,
        mode: "direct",
        runState: {
          version: "1999",
          items: [],
          sentThrough: 0,
          execution: null,
          mode: "direct",
          blocked: null,
        },
      },
      ["say:withdrawn"],
    ],
    [
      "w3",
      "admitted",
      {
        outcome: "already_started",
        seq: "1999",
        pending: null,
        mode: "direct",
        runState: {
          version: "1999",
          items: [],
          sentThrough: 0,
          execution: null,
          mode: "direct",
          blocked: null,
        },
      },
      ["say:already"],
    ],
    ["w4", "admitted", new HttpResponseError("gone", 404, null), []],
    ["w5", "kept", undefined, []],
    ["w6", "admitted", new Error("offline"), ["error:Couldn't stop. Try again."]],
  ];
  for (const [id, outcome, server, expected] of cases) {
    vi.clearAllMocks();
    withdrawOutcome = outcome;
    if (server instanceof Error) api.withdrawThreadControl.mockRejectedValue(server);
    else api.withdrawThreadControl.mockResolvedValue(server);
    await show([record(id, { posted: outcome !== "removed" })]);
    const row = view.rows.find((candidate) => candidate.id === id);
    await act(async () => view.withdraw(row as never));
    await tick();
    const heard = [
      ...announcements.announce.mock.calls.map(([copy]) => `say:${copy}`),
      ...announcements.announceError.mock.calls.map(([copy]) => `error:${copy}`),
    ].map((line) =>
      /stopped/i.test(line) ? "say:withdrawn" : /already/i.test(line) ? "say:already" : line,
    );
    expect(heard, id).toEqual(expected);
    await show([]);
  }
});

const switchItem = (id: string, deliveryState: "awaiting_run" | "waiting") => ({
  id,
  seq: 1,
  intent: "control" as const,
  control: { kind: "write_mode" as const, mode: "draft" as const },
  provenance: { kind: "user" as const },
  deliveryState,
  summary: "",
  enqueuedAt: "",
});
const messageItem = {
  ...switchItem("m1", "awaiting_run"),
  intent: "message" as const,
  control: null,
};
const recordOf = (version: string, items: unknown[]) => ({
  version,
  items,
  sentThrough: 0,
  execution: null,
  mode: "direct" as const,
  blocked: null,
});
const feed = (type: "snapshot" | "record", version: string, items: unknown[]) =>
  act(async () => slices.feed({ type, runState: recordOf(version, items) }));
const mount = () =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );

it("calls a switch queued only when the server says a reply it can't affect holds the chat", async () => {
  await mount();
  // Made in an idle chat, then a send starts a reply: the reply applies it, so no flip.
  await feed("snapshot", "6", [switchItem("s1", "awaiting_run")]);
  expect(view.rows.map((row) => row.waiting)).toEqual([false]);
  replyRunning = true;
  await show([]);
  expect(view.rows.map((row) => row.waiting)).toEqual([false]);
  // Made while a reply held the chat: it waits, in this tab and in any other.
  await feed("record", "9", [switchItem("s1", "waiting")]);
  expect(view.rows.map((row) => row.waiting)).toEqual([true]);
});

it("announces a switch as queued from the server's delivery state, not the running reply", async () => {
  await mount();
  await feed("snapshot", "3", []);
  // A reply is running, but the server says this switch awaits the next run: not queued.
  replyRunning = true;
  await feed("record", "4", [switchItem("a1", "awaiting_run")]);
  expect(announcements.announce).toHaveBeenLastCalledWith("Switched to draft mode");
  // The reply is over, but the server says this one waits behind a run: queued.
  replyRunning = false;
  await feed("record", "5", [switchItem("a1", "awaiting_run"), switchItem("a2", "waiting")]);
  expect(announcements.announce).toHaveBeenLastCalledWith("Switch to draft mode queued");
});

it("invalidates thread and Works reads when a write-mode switch enters or leaves the pending inbox, not on other inbox changes", async () => {
  await mount();
  await feed("snapshot", "1", [messageItem]);
  expect(invalidateWriteModeReads).not.toHaveBeenCalled();
  await feed("record", "2", [messageItem, switchItem("c1", "awaiting_run")]);
  expect(invalidateWriteModeReads).toHaveBeenCalledTimes(1);
  await feed("record", "3", [switchItem("c1", "awaiting_run")]);
  expect(invalidateWriteModeReads).toHaveBeenCalledTimes(1);
  await feed("record", "4", []);
  expect(invalidateWriteModeReads).toHaveBeenCalledTimes(2);
});
