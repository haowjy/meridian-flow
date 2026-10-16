/** The hand-back operation over in-memory ports: the state transitions the app and ./mf share. */
import type { HandBackResult, PendingInboxItem, RunState } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { handBackCards } from "../cards/hand-back-cards";
import { stopStatus } from "../run-state/fold-messages";
import {
  INITIAL_RUN_STATE_VIEW,
  type RunStateView,
  receiveRecord,
} from "../run-state/run-state-view";
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
    ports,
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
  it("allocates failures before saving, gives Retry a new occurrence, and preserves it on reload", async () => {
    const r = rig({ saveFails: true });
    const key = (op = r.op) => handBackCards(op.unresolved(), r.view())[0]?.key;
    await r.op.press({ kind: "queue", ids: [M1] });
    const first = key();
    await r.op.retry(REQ);
    const second = key();
    expect(second).not.toBe(first);
    expect(r.sent).toHaveLength(0);

    r.state.saveFails = false;
    await r.op.retry(REQ);
    const third = key();
    expect(new Set([first, second, third]).size).toBe(3);
    const persisted = JSON.stringify([...r.stored]);
    r.stored.clear();
    for (const [id, command] of JSON.parse(persisted)) r.stored.set(id, command);
    const reloaded = createHandBackOperation({ threadId: "t1", ports: r.ports });
    await reloaded.resume();
    expect(key(reloaded)).toBe(third);
    await reloaded.retry(REQ);
    expect(key(reloaded)).not.toBe(third);
    expect(r.sent.every((sent) => JSON.stringify(sent) === JSON.stringify(r.sent[0]))).toBe(true);

    // A refused Retry metadata write must not turn an already durable command into page memory.
    let nextId = 0;
    const resumed = createHandBackOperation({
      threadId: "t1",
      ports: { ...r.ports, newId: () => `retry-${++nextId}` },
    });
    await resumed.resume();
    r.state.saveFails = true;
    const beforeSaveFailure = key(resumed);
    await resumed.retry(REQ);
    const failedSaveKey = key(resumed);
    expect(failedSaveKey).not.toBe(beforeSaveFailure);
    expect(resumed.unresolved()[0]?.status).toBe("ambiguous");
    await resumed.press({ kind: "queue", ids: [M2] });
    expect(handBackCards(resumed.unresolved(), r.view()).map((card) => card.key)).toContain(
      failedSaveKey,
    );
    r.stored.delete(REQ);
    resumed.reconcile();
    expect(resumed.unresolved().map((entry) => entry.requestId)).not.toContain(REQ);
  });

  it.each([
    {
      row: "a validated 2xx hands the content back, removes the turns at the record's version, and retires the intent",
      reply: async () => answerBody([M1, M2]),
      outcome: "confirmed",
    },
    {
      row: "a 409 drops the command and the intent",
      reply: async () => ({ status: 409, body: {} }),
      outcome: "refused",
    },
    {
      row: "no answer keeps the command and fails the intent",
      reply: async () => ({ status: null }),
      outcome: "ambiguous",
    },
  ])("$row", async ({ reply, outcome }) => {
    // Risk: the shared lifecycle diverging between clients (#861 D1, L2): retirement, replay, and
    // the one order that prevents loss (the command is saved before it is posted).
    const r = rig();
    r.answer(reply);
    const result = await r.op.press({ kind: "queue", ids: [M1, M2] });
    expect(result.kind).toBe(outcome);
    expect(r.calls.indexOf("record")).toBeLessThan(r.calls.indexOf("post"));
    const intents = r.view().intents.filter((i) => i.kind === "handBack");
    if (result.kind === "confirmed") {
      expect(r.written).toEqual([M1, M2]);
      expect(r.calls).toContain(`remove:${M1},${M2}@1001`);
      expect(intents).toEqual([]);
    } else {
      expect(r.written).toEqual([]);
      expect(r.calls.filter((c) => MUTATING.includes(c) || c.startsWith("remove"))).toEqual(
        outcome === "refused" ? ["drop"] : [],
      );
      expect(intents.map((i) => i.failed)).toEqual(outcome === "ambiguous" ? [true] : []);
    }
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
    let heardResume = 0;
    r.op.subscribe(() => heardResume++);
    const [resumed] = await r.op.resume();
    expect(resumed?.kind).toBe("confirmed");
    expect(r.written).toEqual([M1]);
    expect(r.stored.size).toBe(0);
    expect(r.op.unresolved()).toEqual([]);
    expect(heardResume).toBeGreaterThan(0);

    // Every change to what is unresolved notifies, so no caller redraws for the operation.
    const gone = rig({ acceptFails: true });
    gone.answer(async () => answerBody([M1]));
    await gone.op.press({ kind: "queue", ids: [M1] });
    let heard = 0;
    gone.op.subscribe(() => heard++);
    gone.stored.delete(REQ);
    gone.op.reconcile();
    expect(gone.op.unresolved()).toEqual([]);
    expect(heard).toBe(1);
    gone.op.reconcile();
    expect(heard).toBe(1);

    const refused = rig();
    refused.answer(async () => ({ status: 409, body: {} }));
    expect((await refused.op.press({ kind: "queue", ids: [M1] })).kind).toBe("refused");
    heard = 0;
    refused.op.subscribe(() => heard++);
    refused.op.dismiss(REQ);
    expect(refused.op.unresolved()).toEqual([]);
    expect(heard).toBe(1);
  });

  it("keeps a card for each unresolved command after the hand-back removed its rows", () => {
    // Risk (Q1): the card vanishing with the rows a messages.handed_back frame removed.
    const rowsGone = receiveRecord(INITIAL_RUN_STATE_VIEW, record("2000"));
    const base = {
      requestId: REQ,
      commandKind: "queue" as const,
      count: 2,
      targetExecutionId: null,
      occurrence: { requestId: REQ, attempt: 1 },
    };
    expect(handBackCards([{ ...base, status: "ambiguous" }], rowsGone)).toMatchObject([
      { copy: "hand-back-failed", action: "try_again", count: 2 },
    ]);
    expect(handBackCards([{ ...base, status: "unsaved" }], rowsGone)).toMatchObject([
      { copy: "hand-back-failed", action: "try_again" },
    ]);
    expect(handBackCards([{ ...base, status: "refused" }], rowsGone)).toMatchObject([
      { copy: "hand-back-refused", action: "dismiss" },
    ]);
  });

  it("one attempt per request: a retry or resume in flight is joined and delivers once", async () => {
    // Risk (QB2): two Try again presses posting twice, the second's lost answer resurrecting a
    // card after the first confirmed.
    const r = rig();
    r.answer(async () => ({ status: null }));
    await r.op.press({ kind: "queue", ids: [M1] });
    const answers: ((value: unknown) => void)[] = [];
    r.answer(() => new Promise((resolve) => answers.push(resolve)));
    const a = r.op.retry(REQ);
    const b = r.op.retry(REQ);
    const resumed = r.op.resume();
    expect(r.sent).toHaveLength(2); // the lost press, then one joined retry
    answers[0]?.(answerBody([M1]));
    expect((await a)?.kind).toBe("confirmed");
    expect((await b)?.kind).toBe("confirmed");
    await resumed;
    expect(r.written).toEqual([M1]);
    expect(r.op.unresolved()).toEqual([]);
    expect(r.view().intents.some((i) => i.kind === "handBack" && i.failed)).toBe(false);
  });

  it("Stop facts read the same whichever route started the Stop, and a failed Stop's card follows its own reply", async () => {
    // Risk (QB2, QB4): Stop recovered through retry or resume showing idle; a failed Stop's card
    // blaming a later reply.
    const ex = { executionId: "e1", currentTurnId: "t" };
    const running = receiveRecord(INITIAL_RUN_STATE_VIEW, {
      ...record("1000", [item(M1, 1)]),
      sentThrough: 1,
      execution: ex,
    });
    const r = rig();
    r.answer(async () => ({ status: null }));
    await r.op.press({ kind: "stop", view: running });
    expect(r.op.stopFacts()).toEqual({
      request: "idle",
      cancelledExecutionId: null,
      failedStops: [{ targetExecutionId: "e1", candidates: 1 }],
    });
    const [card] = handBackCards(r.op.unresolved(), running);
    expect(card?.copy).toBe("stop-failed");
    const later = receiveRecord(running, {
      ...record("2000"),
      execution: { executionId: "e2", currentTurnId: "t2" },
    });
    expect(handBackCards(r.op.unresolved(), later)[0]?.copy).toBe("hand-back-failed");

    let answer: (value: unknown) => void = () => {};
    r.answer(() => new Promise((resolve) => (answer = resolve)));
    const retried = r.op.retry(REQ);
    expect(r.op.stopFacts().request).toBe("pending");
    answer({
      status: 200,
      body: {
        threadId: "t1",
        cancelledExecutionId: "e1",
        handedBack: handedBack([M1]),
        answered: [],
        gone: [],
        runState: { ...record("1001"), execution: ex },
      },
    });
    await retried;
    expect(r.op.stopFacts()).toEqual({
      request: "idle",
      cancelledExecutionId: "e1",
      failedStops: [],
    });
  });

  it("a failed Stop with nothing queued shows while its reply runs and is moot once it ends", async () => {
    // Risk: a Stop with no candidates leaving a hand-back card (and a failed Stop button) behind.
    const ex = { executionId: "e1", currentTurnId: "t" };
    const running = receiveRecord(INITIAL_RUN_STATE_VIEW, { ...record("1000"), execution: ex });
    const ended = receiveRecord(running, record("1001"));
    const r = rig();
    r.answer(async () => ({ status: 409, body: {} }));
    await r.op.press({ kind: "stop", view: running });
    const facts = r.op.stopFacts();
    expect(handBackCards(r.op.unresolved(), running)[0]?.copy).toBe("stop-failed");
    expect(stopStatus(running, facts)).toBe("failed");
    expect(handBackCards(r.op.unresolved(), ended)).toEqual([]);
    expect(stopStatus(ended, facts)).toBe("idle");

    // The refused moot Stop must not stand in for a later reply's failed Stop.
    const next = receiveRecord(ended, {
      ...record("1002"),
      execution: { executionId: "e2", currentTurnId: "t2" },
    });
    await r.op.press({ kind: "stop", view: next });
    expect(r.op.stopFacts().failedStops).toHaveLength(1);
    expect(stopStatus(next, r.op.stopFacts())).toBe("failed");
  });
});
