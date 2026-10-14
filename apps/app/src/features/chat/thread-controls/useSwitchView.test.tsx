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
    snapshot: null,
    journal,
    replyRunning: false,
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
