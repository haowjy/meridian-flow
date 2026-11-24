/**
 * Guards the one risk this driver exists for: a command sent twice with different effects,
 * dropped, or reordered across a reload, two tabs, a frozen page and a lost answer. Several
 * tabs share one journal, one lock and one simulated server that applies a command id once.
 * Pins implementation decisions: backoff constants, the 15 s deadline, the 10 s "not sent" line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandDriver, NOT_SENT_AFTER_MS } from "./driver.js";
import { createMemoryJournal } from "./memory-journal.js";
import type {
  CommandKind,
  CommandRecord,
  Journal,
  TransportAnswer,
  TransportRequest,
} from "./types.js";

type Fault = "drop_request" | "drop_response" | { status: number; code?: string };

class Server {
  effects: string[] = [];
  stored = new Map<string, { status: "done" | "refused" | "never"; result?: unknown }>();
  requests: { path: string; commandId?: string }[] = [];
  faults: Fault[] = [];
  refuse = new Set<string>();
  refuseOnce = new Set<string>();

  active = new Map<string, Map<string, number>>();
  overlaps: string[] = [];
  latency = 0;

  handle = async (request: TransportRequest, signal: AbortSignal): Promise<TransportAnswer> => {
    const posted = request.method !== "GET" && !request.path.endsWith("/resolve");
    const lane = posted ? (request.body as { label?: string }).label?.[0] : undefined;
    const id = (request.body as { commandId?: string } | undefined)?.commandId ?? "";
    if (lane) {
      const running = this.active.get(lane) ?? new Map<string, number>();
      if ([...running.keys()].some((other) => other !== id)) this.overlaps.push(lane);
      running.set(id, (running.get(id) ?? 0) + 1);
      this.active.set(lane, running);
    }
    try {
      if (this.latency > 0) await new Promise((resolve) => setTimeout(resolve, this.latency));
      return await this.serve(request, signal);
    } finally {
      if (lane) {
        const running = this.active.get(lane);
        const left = (running?.get(id) ?? 1) - 1;
        if (left > 0) running?.set(id, left);
        else running?.delete(id);
      }
    }
  };

  private serve = async (
    request: TransportRequest,
    signal: AbortSignal,
  ): Promise<TransportAnswer> => {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const body = (request.body ?? {}) as { commandId?: string; label?: string; kind?: string };
    this.requests.push({ path: request.path, commandId: body.commandId });
    const fault = this.faults.shift();
    if (fault === "drop_request") throw new Error("network");
    if (fault && typeof fault === "object")
      return { status: fault.status, body: null, code: fault.code ?? null };
    const answer = this.answer(request, body);
    if (fault === "drop_response") throw new Error("network");
    return answer;
  };

  private answer(
    request: TransportRequest,
    body: { commandId?: string; label?: string; kind?: string },
  ): TransportAnswer {
    const ok = (payload: unknown): TransportAnswer => ({ status: 200, body: payload, code: null });
    if (request.method === "GET") {
      const id = request.path.split("/").at(-1) as string;
      const found = this.stored.get(id);
      return ok(found ? { status: "stored", kind: "x", outcome: found } : { status: "none" });
    }
    if (request.path.endsWith("/resolve")) {
      const id = request.path.split("/").at(-2) as string;
      if (!this.stored.has(id)) this.stored.set(id, { status: "never" });
      return ok({ commandId: id, outcome: this.stored.get(id) });
    }
    const id = body.commandId as string;
    const known = this.stored.get(id);
    if (known?.status === "done") return ok({ label: body.label });
    if (known) return { status: 409, body: null, code: "x" };
    if (this.refuse.has(body.label as string) || this.refuseOnce.delete(body.label as string)) {
      this.stored.set(id, { status: "refused", result: { refusal: "no" } });
      return { status: 409, body: null, code: "x" };
    }
    this.effects.push(body.label as string);
    this.stored.set(id, { status: "done", result: { label: body.label } });
    return ok({ label: body.label });
  }
}

class World {
  server = new Server();
  private readonly store = createMemoryJournal();
  holdTransaction: { at: number; ms: number } | null = null;
  jitter: (() => number) | null = null;
  transactions = 0;
  journal: Journal & { failNext(error: Error): void } = {
    failNext: (error) => this.store.failNext(error),
    read: () => this.store.read(),
    close: () => this.store.close(),
    transact: async (decide) => {
      const n = ++this.transactions;
      const wait =
        this.holdTransaction?.at === n ? this.holdTransaction.ms : (this.jitter?.() ?? 0);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      return this.store.transact(decide);
    },
  };
  online = true;
  logs: unknown[] = [];
  settledSeen: string[] = [];
  private holder: { release: () => void } | null = null;
  private waiting: { grant: (release: () => void) => void; signal: AbortSignal }[] = [];
  private listeners = new Set<() => void>();
  migrated: number[] = [];

  kind: CommandKind<{ label: string }> = {
    version: 2,
    migrate: (body, from) => {
      this.migrated.push(from);
      return { label: (body as { label: string }).label };
    },
    request: ({ body }) => ({ method: "POST", path: "/api/x", body: { label: body.label } }),
    onSettled: (record) => this.settledSeen.push(`${record.id}:${record.state}`),
  };

  lock = {
    acquire: (signal: AbortSignal) =>
      new Promise<() => void>((resolve, reject) => {
        const entry = {
          signal,
          grant: (release: () => void) => resolve(release),
        };
        signal.addEventListener("abort", () => {
          this.waiting = this.waiting.filter((other) => other !== entry);
          reject(new DOMException("aborted", "AbortError"));
        });
        this.waiting.push(entry);
        this.grantNext();
      }),
  };

  private grantNext() {
    if (this.holder) return;
    const next = this.waiting.shift();
    if (!next) return;
    const holder = {
      release: () => {
        if (this.holder !== holder) return;
        this.holder = null;
        this.grantNext();
      },
    };
    this.holder = holder;
    next.grant(holder.release);
  }

  async tab({ silent = false } = {}): Promise<CommandDriver> {
    const listener = new Set<() => void>();
    const mine = {
      post: () => {
        for (const l of this.listeners) if (!listener.has(l)) l();
      },
    };
    const driver = new CommandDriver({
      journal: this.journal,
      lock: this.lock,
      transport: this.server.handle,
      changes: {
        post: silent ? () => undefined : mine.post,
        subscribe: (l) => {
          listener.add(l);
          this.listeners.add(l);
          return () => {
            listener.delete(l);
            this.listeners.delete(l);
          };
        },
        close() {},
      },
      online: () => this.online,
      held: () => false,
      unreadable: () => {},
      routes: {
        lookup: (id) => `/api/commands/${id}`,
        resolve: (id) => `/api/commands/${id}/resolve`,
      },
      kinds: { x: this.kind as CommandKind },
      log: (entry) => this.logs.push(entry),
    });
    await driver.open();
    await vi.advanceTimersByTimeAsync(0);
    return driver;
  }
}

const submit = (driver: CommandDriver, label: string, lanes = ["a"]) =>
  driver.submit({ kind: "x", lanes, body: { label } });
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const through = async <T>(promise: Promise<T>): Promise<T> => {
  let done = false;
  const result = promise.finally(() => {
    done = true;
  });
  while (!done) await vi.advanceTimersByTimeAsync(50);
  return result;
};
const states = (driver: CommandDriver) =>
  Object.fromEntries(
    driver
      .getSnapshot()
      .records.map((r: CommandRecord) => [(r.body as { label: string }).label, r.state]),
  );

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("one delivery, whatever goes wrong on the way", () => {
  it("sends a lost answer again under the same id and the server applies it once", async () => {
    const world = new World();
    const tab = await world.tab();
    world.server.faults = ["drop_response", "drop_response", "drop_request"];
    await submit(tab, "one");
    await settle(30_000);
    expect(states(tab)).toEqual({ one: "done" });
    expect(world.server.effects).toEqual(["one"]);
    expect(
      new Set(world.server.requests.filter((r) => r.commandId).map((r) => r.commandId)).size,
    ).toBe(1);
  });

  it("looks a sent record up after a reload instead of sending its body again", async () => {
    const world = new World();
    const first = await world.tab();
    world.server.faults = ["drop_response"];
    await submit(first, "one");
    await settle(0);
    first.suspend();
    first.stop();
    const posts = () => world.server.requests.filter((r) => r.path === "/api/x").length;
    const before = posts();
    const second = await world.tab();
    await settle(1_000);
    expect(posts()).toBe(before);
    expect(states(second)).toEqual({ one: "done" });
    expect(world.server.effects).toEqual(["one"]);
  });

  it("lets one tab deliver, and the next takes over when it freezes", async () => {
    const world = new World();
    const a = await world.tab();
    const b = await world.tab();
    world.online = false;
    await submit(b, "one");
    a.suspend();
    world.online = true;
    b.nudge();
    await settle(0);
    expect(world.server.effects).toEqual(["one"]);
    await submit(a, "two");
    await settle(0);
    expect(states(a)).toEqual({ one: "done", two: "done" });
    a.resume();
    await settle(0);
    expect(world.server.effects).toEqual(["one", "two"]);
  });

  it("keeps a lane in order when an earlier command waits out an outage", async () => {
    const world = new World();
    const tab = await world.tab();
    world.server.faults = ["drop_request"];
    await submit(tab, "one");
    await submit(tab, "two");
    await submit(tab, "other", ["b"]);
    await settle(0);
    expect(world.server.effects).toEqual(["other"]);
    await settle(1_000);
    expect(world.server.effects).toEqual(["other", "one", "two"]);
  });

  it("settles a turned-away command through resolve and shows what the server stored", async () => {
    const world = new World();
    const tab = await world.tab();
    world.server.refuse.add("one");
    await submit(tab, "one");
    await settle(0);
    const [record] = tab.getSnapshot().records;
    expect(record?.state).toBe("never");
    expect(record?.outcome).toEqual({ status: "never", result: { refusal: "no" }, code: "x" });
    expect(world.server.requests.some((r) => r.path.endsWith("/resolve"))).toBe(true);
  });

  it("retry keeps the record's place while nothing later was sent, and takes a new id for the server", async () => {
    const world = new World();
    const tab = await world.tab();
    world.server.refuse.add("one");
    const { id, seq, sendId } = await submit(tab, "one");
    await settle(0);
    world.server.refuse.clear();
    await tab.retry(id);
    await settle(0);
    const [record] = tab.getSnapshot().records;
    expect(record).toMatchObject({ id, seq, state: "done" });
    expect(record?.sendId).not.toBe(sendId);
    expect(world.server.effects).toEqual(["one"]);
  });

  it("retry goes behind a later command of its lane that was already sent", async () => {
    const world = new World();
    const tab = await world.tab();
    world.server.refuseOnce.add("one");
    const one = await submit(tab, "one");
    await submit(tab, "two");
    await settle(0);
    expect(world.server.effects).toEqual(["two"]);
    await tab.retry(one.id);
    await settle(0);
    const records = tab.getSnapshot().records;
    expect(records.map((r) => (r.body as { label: string }).label)).toEqual(["two", "one"]);
    expect(records.find((r) => r.id === one.id)?.seq).toBeGreaterThan(one.seq);
    expect(world.server.effects).toEqual(["two", "one"]);
  });

  it("does not send a command whose lane gained an earlier one after it was chosen", async () => {
    const world = new World();
    const tab = await world.tab();
    const other = await world.tab({ silent: true });
    world.server.refuseOnce.add("one");
    const one = await submit(tab, "one");
    await settle(0);
    world.holdTransaction = { at: world.transactions + 2, ms: 500 };
    await submit(tab, "two");
    await other.retry(one.id);
    await settle(5_000);
    expect(world.server.overlaps).toEqual([]);
    expect(world.server.effects).toEqual(["one", "two"]);
  });

  it("does not prune a record that another tab retried after this tab last read", async () => {
    const world = new World();
    const holder = await world.tab();
    const other = await world.tab({ silent: true });
    world.server.refuseOnce.add("one");
    const { id } = await submit(holder, "one");
    await settle(0);
    await settle(30 * 24 * 60 * 60 * 1000 - 1_000);
    await other.retry(id);
    await settle(2_000);
    expect(world.server.effects).toEqual(["one"]);
    expect(states(holder)).toEqual({ one: "done" });
  });

  it("pauses an account the server turns away, and sends again once resumed", async () => {
    const world = new World();
    const tab = await world.tab();
    world.server.faults = [{ status: 409, code: "wrong_account" }];
    await submit(tab, "one");
    await settle(60_000);
    expect(tab.getSnapshot().paused).toBe(true);
    expect(world.server.effects).toEqual([]);
    tab.resume();
    await settle(0);
    expect(world.server.effects).toEqual(["one"]);
    expect(tab.getSnapshot().paused).toBe(false);
  });

  it("keeps resending after a 500, slowly, and logs it without the body", async () => {
    const world = new World();
    const tab = await world.tab();
    world.server.faults = [{ status: 500 }];
    await submit(tab, "one");
    await settle(0);
    expect(world.logs).toHaveLength(1);
    expect(JSON.stringify(world.logs)).not.toContain("label");
    await settle(29_000);
    expect(world.server.effects).toEqual([]);
    await settle(2_000);
    expect(world.server.effects).toEqual(["one"]);
  });

  it("migrates an unsent body when it first leaves and never a sent one", async () => {
    const world = new World();
    const tab = await world.tab();
    world.online = false;
    await tab.submit({ kind: "x", lanes: ["a"], body: { label: "old" } });
    await world.journal.transact(({ records }) => ({
      change: { put: records.map((r) => ({ ...r, bodyVersion: 1 })) },
      result: null,
    }));
    world.server.faults = ["drop_response"];
    world.online = true;
    tab.nudge();
    await settle(2_000);
    expect(world.migrated).toEqual([1]);
    expect(world.server.effects).toEqual(["old"]);
  });

  it("tells the writer once a command has gone unanswered for ten seconds, or offline", async () => {
    const world = new World();
    const tab = await world.tab();
    world.server.faults = Array.from({ length: 20 }, () => "drop_request" as const);
    await submit(tab, "one");
    expect(tab.getSnapshot().notSent).toBe(false);
    await settle(NOT_SENT_AFTER_MS);
    expect(tab.getSnapshot().notSent).toBe(true);
    world.server.faults = [];
    await settle(30_000);
    expect(tab.getSnapshot().notSent).toBe(false);
    world.online = false;
    await submit(tab, "two");
    expect(tab.getSnapshot().notSent).toBe(true);
  });

  it("refuses a command the journal cannot keep", async () => {
    const world = new World();
    const tab = await world.tab();
    world.journal.failNext(new Error("quota"));
    await expect(submit(tab, "one")).rejects.toThrow("could not be saved");
    expect(world.server.requests).toEqual([]);
  });

  it("observation is per tab: another tab's read never retires this tab's effect", async () => {
    const world = new World();
    const a = await world.tab();
    const b = await world.tab();
    const { id } = await submit(a, "one");
    await settle(0);
    expect(world.settledSeen.filter((s) => s.endsWith("done"))).toHaveLength(2);
    await a.observe(() => true);
    expect(a.getSnapshot().records[0]?.observed).toBe(true);
    expect(b.getSnapshot().records[0]).toMatchObject({ id, observed: false });
    await settle(61_000);
    expect(a.getSnapshot().records).toHaveLength(0);
    expect(b.getSnapshot().records).toMatchObject([{ id, state: "done", observed: false }]);
    await b.observe((record) => record.id === id);
    expect(b.getSnapshot().records).toHaveLength(0);
  });

  it("one observation covers every record settled before it, so a missed read never strands one", async () => {
    const world = new World();
    const tab = await world.tab();
    await submit(tab, "one");
    await submit(tab, "two");
    await settle(0);
    await tab.observe((record) => record.settledAt !== undefined);
    expect(tab.getSnapshot().records.every((record) => record.observed)).toBe(true);
  });
});

describe("schedules of tabs, outages and reloads", () => {
  const random = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`applies every command once and in lane order (seed ${seed})`, async () => {
      const next = random(seed);
      const world = new World();
      world.server.latency = 200;
      world.jitter = () => (next() < 0.6 ? Math.floor(next() * 800) : 0);
      const tabs: CommandDriver[] = [await world.tab(), await world.tab()];
      let n = 0;
      for (let step = 0; step < 60; step++) {
        const roll = next();
        const tab = tabs[Math.floor(next() * tabs.length)] as CommandDriver;
        if (roll < 0.35) {
          const lane = next() < 0.5 ? "a" : "b";
          const label = `${lane}${n++}`;
          if (next() < 0.2) world.server.refuseOnce.add(label);
          await through(submit(tab, label, [lane]));
        } else if (roll < 0.5) {
          const never = tab.getSnapshot().records.find((r) => r.state === "never");
          if (never) await through(tab.retry(never.id));
        } else if (roll < 0.6) {
          world.server.faults.push(next() < 0.5 ? "drop_request" : "drop_response");
        } else if (roll < 0.7) {
          tab.suspend();
        } else if (roll < 0.8) {
          tab.resume();
        } else if (roll < 0.85) {
          tab.suspend();
          tab.stop();
          tabs[tabs.indexOf(tab)] = await world.tab();
        } else {
          world.online = next() < 0.7;
          tab.nudge();
        }
        await settle(Math.floor(next() * 3_000));
      }
      world.online = true;
      world.server.faults = [];
      for (const tab of tabs) {
        tab.resume();
        tab.nudge();
      }
      await settle(120_000);
      for (let round = 0; round < 3; round++) {
        for (const record of tabs[0]?.getSnapshot().records ?? [])
          if (record.state === "never") await through(tabs[0]?.retry(record.id) as Promise<void>);
        await settle(120_000);
      }
      expect(world.server.overlaps).toEqual([]);
      const duplicated = world.server.effects.filter((l, i, all) => all.indexOf(l) !== i);
      expect(duplicated).toEqual([]);
      const records = tabs[0]?.getSnapshot().records ?? [];
      expect(records.every((r) => r.state === "done")).toBe(true);
      expect([...world.server.effects].sort()).toEqual(
        records.map((r) => (r.body as { label: string }).label).sort(),
      );
      for (const lane of ["a", "b"])
        expect(world.server.effects.filter((l) => l.startsWith(lane))).toEqual(
          records
            .filter((r) => r.lanes.includes(lane))
            .map((r) => (r.body as { label: string }).label),
        );
    });
  }
});
