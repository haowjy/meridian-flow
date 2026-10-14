// @vitest-environment jsdom
/**
 * The view's shell with real React and an injected API, transport and journal: what Stop
 * announces, and when. The display itself is `switch-view.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
const api = vi.hoisted(() => ({ withdrawThreadControl: vi.fn() }));
vi.mock("@/client/api/threads-api", () => api);
const announcements = vi.hoisted(() => ({
  announce: vi.fn(),
  announceError: vi.fn(),
  useIsThreadPendingCreation: () => false,
}));
vi.mock("@/client/stores", () => announcements);
vi.mock("@/client/providers/TransportProvider", () => ({
  useThreadTransport: () => ({ subscribe: () => () => undefined }),
}));
vi.mock("@/client/query/project-invalidation", () => ({
  invalidateProjectThreadData: vi.fn(),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HttpResponseError } from "@/client/api/http-client";
import { type SwitchJournal, type SwitchView, useSwitchView } from "./useSwitchView";

type SwitchViewInput = Parameters<typeof useSwitchView>[0];

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
let heldSnapshot: SwitchViewInput["snapshot"] = null;
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
    turns: [],
    snapshot: heldSnapshot,
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
  heldSnapshot = null;
  replyRunning = false;
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
      { outcome: "withdrawn", seq: "1999", pending: null, mode: "direct" },
      ["say:withdrawn"],
    ],
    [
      "w3",
      "admitted",
      { outcome: "already_started", seq: "1999", pending: null, mode: "direct" },
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

it("calls a switch queued only when the server says a reply it can't affect holds the chat", async () => {
  const heldBy = (deliveryState: "awaiting_run" | "waiting", nextSeq: string) =>
    ({
      nextSeq,
      thread: { aiWriteMode: "direct" },
      liveState: {
        pending: {
          items: [
            {
              id: "s1",
              seq: 1,
              intent: "control",
              control: { kind: "write_mode", mode: "draft" },
              provenance: { kind: "user" },
              deliveryState,
              summary: "",
              enqueuedAt: "",
            },
          ],
        },
      },
    }) as unknown as SwitchViewInput["snapshot"];
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  // Made in an idle chat, then a send starts a reply: the reply applies it, so no flip.
  heldSnapshot = heldBy("awaiting_run", "6");
  await show([]);
  expect(view.rows.map((row) => row.waiting)).toEqual([false]);
  replyRunning = true;
  await show([]);
  expect(view.rows.map((row) => row.waiting)).toEqual([false]);
  // Made while a reply held the chat: it waits, in this tab and in any other.
  heldSnapshot = heldBy("waiting", "9");
  await show([]);
  expect(view.rows.map((row) => row.waiting)).toEqual([true]);
});

it("announces a switch as queued from the server's delivery state, not the running reply", async () => {
  const empty = {
    nextSeq: "3",
    thread: { aiWriteMode: "direct" },
    liveState: { pending: { items: [] } },
  } as unknown as SwitchViewInput["snapshot"];
  const answered = (id: string, deliveryState: "awaiting_run" | "waiting", seq: string) =>
    record(id, {
      posted: true,
      answer: {
        outcome: "queued",
        seq,
        mode: "direct",
        pending: {
          id,
          seq: Number(seq),
          intent: "control",
          control: { kind: "write_mode", mode: "draft" },
          provenance: { kind: "user" },
          deliveryState,
          summary: "",
          enqueuedAt: "",
        },
      },
    });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  heldSnapshot = empty;
  await show([]);
  // A reply is running, but the server says this switch awaits the next run: not queued.
  replyRunning = true;
  await show([answered("a1", "awaiting_run", "4")]);
  expect(announcements.announce).toHaveBeenLastCalledWith("Switched to draft mode");
  // The reply is over, but the server says this one waits behind a run: queued.
  replyRunning = false;
  await show([answered("a1", "awaiting_run", "4"), answered("a2", "waiting", "5")]);
  expect(announcements.announce).toHaveBeenLastCalledWith("Switch to draft mode queued");
});
