/** The hand-back operation over in-memory ports: the state transitions the app and ./mf share. */
import type { HandBackResult, PendingInboxItem, RunState } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  INITIAL_RUN_STATE_VIEW,
  type RunStateView,
  receiveRecord,
} from "../run-state/run-state-view";
import { handBackCards } from "./cards";
import {
  createHandBackOperation,
  type HandBackCommand,
  type HandBackPorts,
  viewRunStatePort,
} from "./operation";

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const REQ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const item = (id: string, seq: number): PendingInboxItem => ({
  id,
  seq,
  intent: "message",
  provenance: { kind: "writer", actorId: "w" },
  deliveryState: "waiting",
  summary: id,
  enqueuedAt: "2026-01-01T00:00:00.000Z",
});
const record = (version: string, items: PendingInboxItem[] = []): RunState => ({
  version,
  items,
  sentThrough: 0,
  execution: null,
  mode: "direct",
  blocked: null,
});
const handedBack = (ids: string[]): HandBackResult["handedBack"] =>
  ids.map((userTurnId) => ({ userTurnId, blocks: [{ type: "text", text: userTurnId }] }));

function rig(options: { saveFails?: boolean; acceptFails?: boolean } = {}) {
  const calls: string[] = [];
  let view: RunStateView = receiveRecord(
    INITIAL_RUN_STATE_VIEW,
    record("1000", [item(M1, 1), item(M2, 2)]),
  );
  const stored = new Map<string, HandBackCommand>();
  const written: string[] = [];
  const state = {
    saveFails: options.saveFails ?? false,
    acceptFails: options.acceptFails ?? false,
  };
  let reply: () => Promise<unknown> = async () => ({ status: null });
  const sent: unknown[] = [];
  const runState = viewRunStatePort(
    (change) => {
      calls.push("intent");
      view = change(view);
    },
    (next) => {
      calls.push("receive");
      view = receiveRecord(view, next);
    },
  );
  const ports: HandBackPorts = {
    http: async (path, body) => {
      calls.push("post");
      sent.push({ path, body });
      return reply() as ReturnType<HandBackPorts["http"]>;
    },
    runState,
    removeTurns: (ids, version) => calls.push(`remove:${ids.join(",")}@${version}`),
    store: {
      pending: () => [...stored.values()],
      record: (c) => {
        calls.push("record");
        if (state.saveFails) return false;
        stored.set(c.requestId, c);
        return true;
      },
      received: () => false,
      accept: (id, content) => {
        calls.push("accept");
        if (state.acceptFails) return false;
        written.push(...content.map((m) => m.userTurnId));
        stored.delete(id);
        return true;
      },
      drop: (id) => {
        calls.push("drop");
        return stored.delete(id);
      },
    },
    newId: () => REQ,
  };
  return {
    op: createHandBackOperation({ threadId: "t1", ports }),
    calls,
    sent,
    stored,
    written,
    state,
    view: () => view,
    answer: (next: () => Promise<unknown>) => {
      reply = next;
    },
  };
}
const MUTATING = ["receive", "accept", "drop"];
const answerBody = (ids: string[], version = "1001") => ({
  status: 200,
  body: { handedBack: handedBack(ids), answered: [], gone: [], runState: record(version) },
});

describe("hand-back operation", () => {
  it.each([
    {
      row: "a validated 2xx applies record, turns, content, then the intent, in that order",
      reply: async () => answerBody([M1, M2]),
      outcome: "confirmed",
      calls: ["record", "intent", "post", "receive", `remove:${M1},${M2}@1001`, "accept", "intent"],
    },
    {
      row: "a 409 drops the command and the intent",
      reply: async () => ({ status: 409, body: {} }),
      outcome: "refused",
      calls: ["record", "intent", "post", "drop", "intent"],
    },
    {
      row: "no answer keeps the command and fails the intent",
      reply: async () => ({ status: null }),
      outcome: "ambiguous",
      calls: ["record", "intent", "post", "intent"],
    },
  ])("$row", async ({ reply, outcome, calls }) => {
    // Risk: the shared lifecycle diverging between clients (#861 D1, L2): order, retirement, replay.
    const r = rig();
    r.answer(reply);
    const result = await r.op.press({ kind: "queue", ids: [M1, M2] });
    expect(result.kind).toBe(outcome);
    expect(r.calls).toEqual(calls);
    if (result.kind === "ambiguous")
      expect(result.request).toEqual({
        path: "/api/threads/t1/hand-back",
        body: { requestId: REQ, ids: [M1, M2] },
      });
    expect(r.stored.has(REQ)).toBe(outcome === "ambiguous");
  });

  it("a malformed answer (unreadable JSON, or a valid envelope whose runState is only { version }) is ambiguous and changes nothing", async () => {
    // Risk: D1, a half-read record applied, or the replay request lost on an unreadable answer.
    const envelope = {
      handedBack: handedBack([M1]),
      answered: [],
      gone: [],
      runState: { version: "1001" },
    };
    for (const body of [undefined, envelope]) {
      const r = rig();
      r.answer(async () => ({ status: 200, body }));
      const result = await r.op.press({ kind: "queue", ids: [M1] });
      expect(result.kind).toBe("ambiguous");
      expect(r.calls.filter((c) => MUTATING.includes(c) || c.startsWith("remove"))).toEqual([]);
      expect(r.stored.has(REQ)).toBe(true);
    }
  });

  it("saves before posting, keeps a command whose content could not be written, and delivers it once on resume", async () => {
    // Risk: words lost to a failed draft write, or doubled by a replay.
    const unsaved = rig({ saveFails: true });
    expect((await unsaved.op.press({ kind: "queue", ids: [M1] })).kind).toBe("unsaved");
    expect(unsaved.sent).toEqual([]);

    const r = rig({ acceptFails: true });
    r.answer(async () => answerBody([M1]));
    expect((await r.op.press({ kind: "queue", ids: [M1] })).kind).toBe("unwritten");
    expect(r.stored.has(REQ)).toBe(true);
    r.state.acceptFails = false;
    const [resumed] = await r.op.resume();
    expect(resumed?.kind).toBe("confirmed");
    expect(r.written).toEqual([M1]);
    expect(r.stored.size).toBe(0);
    expect(r.op.unresolved()).toEqual([]);
  });

  it("keeps a card for each unresolved command after the hand-back removed its rows", () => {
    // Risk (Q1): the card vanishing with the rows a messages.handed_back frame removed.
    const rowsGone = receiveRecord(INITIAL_RUN_STATE_VIEW, record("2000"));
    const base = { requestId: REQ, commandKind: "queue" as const, count: 2 };
    expect(handBackCards([{ ...base, status: "ambiguous" }], rowsGone)).toMatchObject([
      { copy: "hand-back-failed", action: "retry", count: 2 },
    ]);
    expect(handBackCards([{ ...base, status: "unsaved" }], rowsGone)).toMatchObject([
      { copy: "hand-back-failed", action: "retry" },
    ]);
    expect(handBackCards([{ ...base, status: "refused" }], rowsGone)).toMatchObject([
      { copy: "hand-back-refused", action: "dismiss" },
    ]);
  });
});
