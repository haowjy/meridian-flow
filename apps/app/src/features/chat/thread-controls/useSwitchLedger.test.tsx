// @vitest-environment jsdom
/**
 * The ledger's shell with real React and real TanStack Query, and an injected API and journal:
 * the proof loop that settles a switch no live source shows, and what Withdraw announces.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
const api = vi.hoisted(() => ({
  getThreadSnapshot: vi.fn(),
  deserializeThreadSnapshot: (wire: unknown) => wire,
  withdrawThreadControl: vi.fn(),
}));
vi.mock("@/client/api/threads-api", () => api);
const announcements = vi.hoisted(() => ({ announce: vi.fn(), announceError: vi.fn() }));
vi.mock("@/client/stores", () => announcements);
vi.mock("@/client/query/project-invalidation", () => ({
  invalidateProjectThreadData: vi.fn(),
}));

import type { ThreadPendingInbox } from "@meridian/contracts/threads";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HttpResponseError } from "@/client/api/http-client";
import { threadSnapshotQueryOptions } from "@/client/query/thread-snapshot-query";
import { type SwitchJournal, type SwitchLedgerView, useSwitchLedger } from "./useSwitchLedger";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const EMPTY: ThreadPendingInbox = { items: [] };
const wire = () => ({
  thread: { id: "T", userId: "A", projectId: "P", aiWriteMode: "direct" },
  nextSeq: "1",
  turns: [],
  liveState: { pending: EMPTY },
});
const record = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  mode: "draft" as const,
  seq: 1,
  posted: false,
  refused: false,
  failed: false,
  ...over,
});

let root: Root;
let client: QueryClient;
let view: SwitchLedgerView;
let records: ReturnType<typeof record>[] = [];
let withdrawOutcome: "removed" | "admitted" | "kept" = "removed";
let repaint: () => void = () => undefined;

function Probe() {
  const [, render] = React.useReducer((n: number) => n + 1, 0);
  repaint = render;
  // The live host: any producer of the snapshot key, not necessarily useThreadSnapshotSync.
  useQuery({ ...threadSnapshotQueryOptions("T"), staleTime: 0 });
  const journal: SwitchJournal = {
    pending: records as unknown as SwitchJournal["pending"],
    submit: () => true,
    retry: () => undefined,
    withdraw: async () => withdrawOutcome,
    onAnswered: () => () => undefined,
  };
  view = useSwitchLedger({
    threadId: "T",
    projectId: "P",
    writeMode: "direct",
    pending: EMPTY,
    turns: [],
    historyLoaded: true,
    journal,
  });
  return null;
}

const tick = (ms = 20) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const show = async (next: typeof records) => {
  records = next;
  await act(async () => repaint());
};

beforeEach(async () => {
  vi.clearAllMocks();
  records = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
});
const mount = () =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );

describe("useSwitchLedger", () => {
  it("settles a switch no live source shows, with one fresh snapshot, whoever produced the key", async () => {
    // The first fetch is in flight when the record appears and leaves: it began before the
    // record left, so its result proves nothing and the ledger must ask once more.
    let release: (value: unknown) => void = () => undefined;
    api.getThreadSnapshot
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockImplementation(async () => wire());
    await mount();
    await show([record("s1")]);
    await show([]);
    expect(view.rows.map((row) => row.id)).toEqual(["s1"]);
    await act(async () => release(wire()));
    await tick(100);
    expect(api.getThreadSnapshot).toHaveBeenCalledTimes(2);
    expect(view.rows).toEqual([]);
    expect(view.writeMode).toBe("direct");
    await tick(150);
    expect(api.getThreadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("announces a Withdraw only once its outcome is known", async () => {
    api.getThreadSnapshot.mockImplementation(async () => wire());
    await mount();
    await tick();
    const cases: [string, "removed" | "admitted" | "kept", unknown, string[]][] = [
      ["w1", "removed", undefined, ["say:withdrawn"]],
      ["w2", "admitted", { outcome: "withdrawn" }, ["say:withdrawn"]],
      ["w3", "admitted", { outcome: "already_started" }, ["say:already"]],
      ["w4", "admitted", new HttpResponseError("gone", 404, null), []],
      ["w5", "kept", undefined, []],
      ["w6", "admitted", new Error("offline"), ["error:Couldn't withdraw. Try again."]],
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
        /withdrawn/i.test(line) ? "say:withdrawn" : /already/i.test(line) ? "say:already" : line,
      );
      expect(heard, id).toEqual(expected);
      await show([]);
    }
  });
});
