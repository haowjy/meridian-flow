/**
 * The switch ledger as a table: each scenario is a list of source events, and
 * what the writer sees (rows, mode), hears and triggers at the end. The
 * scenarios are the handoffs between sources that two review rounds found
 * broken: journal to inbox, inbox to divider, answer to cache, witness to
 * refetch, witness to Withdraw, and the announcers.
 */
import { expect, it } from "vitest";
import {
  EMPTY_LEDGER,
  type JournalRecord,
  type LedgerEvent,
  ledgerReducer,
  overlaidMode,
  proofNeed,
  switchRows,
  transitions,
} from "./switch-ledger";

type Mode = "draft" | "direct";
const record = (id: string, mode: Mode, over: Partial<JournalRecord> = {}): JournalRecord => ({
  id,
  mode,
  seq: Number(id.slice(1)),
  posted: false,
  refused: false,
  failed: false,
  ...over,
});
const journal = (at: number, ...records: JournalRecord[]): LedgerEvent => ({
  type: "journal",
  at,
  records,
});
const inbox = (at: number, ...items: [string, Mode][]): LedgerEvent => ({
  type: "inbox",
  at,
  items: items.map(([id, mode], serverSeq) => ({ id, mode, serverSeq })),
});
const answer = (
  id: string,
  mode: Mode,
  result: "queued" | "applied" | "cancelled",
  at = 0,
): LedgerEvent => ({ type: "answer", id, mode, result, at });
const snapshot = (
  request: number,
  pending: [string, Mode][],
  named: string[] = [],
): LedgerEvent => ({
  type: "snapshot",
  request,
  pending: pending.map(([id, mode], serverSeq) => ({ id, mode, serverSeq })),
  dividers: named.map((controlId) => ({ controlId })),
});
const dividers = (...items: [string, Mode][]): LedgerEvent => ({
  type: "transcript",
  dividers: items.map(([controlId, mode]) => ({ turnId: `turn-${controlId}`, controlId, mode })),
});
const divider = (controlId: string, mode: Mode): LedgerEvent => dividers([controlId, mode]);
const SETTLED: LedgerEvent = { type: "settled" };
const done = (
  id: string,
  outcome: "removed" | "withdrawn" | "not_found" | "kept",
): LedgerEvent => ({
  type: "withdraw_done",
  id,
  outcome,
});

type Outcome = {
  rows?: string[];
  mode: Mode;
  /** Modes announced as queued, then as switched, in order. */
  heard?: { queued?: Mode[]; switched?: Mode[] };
  waiting?: boolean;
};

const SCENARIOS: { name: string; events: LedgerEvent[]; expect: Outcome }[] = [
  {
    // B1: the inbox drops the row before the divider arrives.
    name: "keeps the row and mode from the inbox dropping it until its divider renders",
    events: [
      SETTLED,
      inbox(1, ["s1", "draft"]),
      inbox(2),
      snapshot(3, [], ["s1"]),
      // The snapshot holds the divider; the transcript has not rendered it yet.
    ],
    expect: { rows: ["s1:queued"], mode: "draft", heard: { queued: ["draft"] } },
  },
  {
    name: "retires the row at the rendered divider and keeps the mode until a snapshot holds it",
    events: [SETTLED, inbox(1, ["s1", "draft"]), inbox(2), divider("s1", "draft")],
    expect: {
      rows: [],
      mode: "draft",
      heard: { queued: ["draft"], switched: ["draft"] },
      waiting: true,
    },
  },
  {
    // Finding 4: the record leaves the journal before the inbox lists it.
    name: "holds a posted switch across the journal dropping it, then the inbox listing it",
    events: [
      SETTLED,
      journal(1, record("s1", "draft", { posted: true })),
      journal(2),
      inbox(3, ["s1", "draft"]),
    ],
    expect: { rows: ["s1:queued"], mode: "draft", heard: { queued: ["draft"] } },
  },
  {
    // N1: Withdraw of a switch whose record is gone and which the server never had.
    name: "settles a Withdraw the server answers 404 when the journal holds no record",
    events: [
      journal(1, record("s1", "draft")),
      journal(2),
      { type: "withdraw_started", id: "s1" },
      done("s1", "not_found"),
    ],
    expect: { rows: [], mode: "direct" },
  },
  {
    name: "does not settle a 404 while the journal still holds a record that may yet post",
    events: [
      journal(1, record("s1", "draft")),
      { type: "withdraw_started", id: "s1" },
      done("s1", "not_found"),
    ],
    expect: { rows: ["s1:sending"], mode: "draft" },
  },
  {
    // N2: only a snapshot whose request began after the last observation proves absence.
    name: "is not settled by a failed fetch, or a fetch that began before the record left",
    events: [
      journal(5, record("s1", "draft", { posted: true })),
      journal(6),
      // A failed fetch sends no event. A joined older request returns an older number.
      snapshot(6, []),
    ],
    expect: { rows: ["s1:sending"], mode: "draft", waiting: true },
  },
  {
    name: "is settled by a fresh snapshot that shows it neither pending nor as a divider",
    events: [journal(5, record("s1", "draft", { posted: true })), journal(6), snapshot(7, [])],
    expect: { rows: [], mode: "direct", waiting: false },
  },
  {
    // Watermark: a snapshot that listed the entry is a live reading at its request, so an older
    // fetch that landed afterwards and doesn't list it proves nothing.
    name: "an older snapshot that does not list it cannot undo a newer snapshot that did",
    events: [
      journal(2, record("s1", "draft", { posted: true })),
      journal(2),
      snapshot(5, [["s1", "draft"]]),
      snapshot(3, []),
    ],
    expect: { rows: ["s1:queued"], mode: "draft" },
  },
  {
    name: "a fresh snapshot that lists it pending keeps the row and moves it to queued",
    events: [
      journal(5, record("s1", "draft", { posted: true })),
      journal(6),
      snapshot(7, [["s1", "draft"]]),
    ],
    expect: { rows: ["s1:queued"], mode: "draft" },
  },
  {
    // N3: answers and evidence arrive out of order; no cache is written, the ledger orders them.
    name: "orders modes by seq whatever the order of answers and evidence",
    events: [
      journal(1, record("s1", "draft", { posted: true }), record("s2", "direct", { posted: true })),
      answer("s2", "direct", "applied"),
      answer("s1", "draft", "applied"),
      dividers(["s1", "draft"], ["s2", "direct"]),
    ],
    expect: { rows: [], mode: "direct" },
  },
  {
    name: "hides a switch back at once, and the server's null answer confirms it against a stale inbox",
    events: [
      SETTLED,
      journal(1, record("s1", "direct", { posted: true })),
      inbox(2, ["s1", "direct"]),
      journal(3, record("s1", "direct", { posted: true }), record("s2", "draft")),
      answer("s2", "draft", "cancelled", 4),
      journal(5),
      inbox(6, ["s1", "direct"]),
    ],
    expect: { rows: [], mode: "direct", heard: { queued: ["direct"] } },
  },
  {
    name: "predicts the switch back before any answer",
    events: [inbox(1, ["s1", "draft"]), journal(2, record("s2", "direct"))],
    expect: { rows: [], mode: "direct" },
  },
  {
    name: "predicts the cancel-out before the answer, and a lost switch back cancels nothing",
    events: [
      inbox(1, ["s1", "direct"]),
      journal(2, record("s2", "draft", { posted: true, failed: true })),
    ],
    expect: { rows: ["s1:queued", "s2:failed:awaiting"], mode: "direct" },
  },
  {
    name: "does not announce a reload's switch as news, but announces one made after",
    events: [
      journal(1, record("s1", "draft", { posted: true })),
      SETTLED,
      inbox(2, ["s1", "draft"]),
      journal(3, record("s2", "direct")),
      answer("s2", "direct", "queued", 4),
    ],
    // s1 is seeded; s2 cancels nothing (s1 is queued, s2 unanswered folds it) then queues.
    expect: { rows: ["s1:queued", "s2:queued"], mode: "direct", heard: { queued: ["direct"] } },
  },
  {
    // R1: the answer to s2 is delayed, and another device queues s3 meanwhile. s2's cancel-out
    // is evidence about s1 only; it says nothing about s3.
    name: "a delayed cancel-out hides the switch it cancelled and not a newer one from another device",
    events: [
      journal(1, record("s1", "draft", { posted: true })),
      inbox(2, ["s1", "draft"]),
      journal(3, record("s1", "draft", { posted: true }), record("s2", "direct", { posted: true })),
      inbox(4, ["s3", "draft"]),
      answer("s2", "direct", "cancelled", 5),
      snapshot(6, [["s3", "draft"]]),
    ],
    expect: { rows: ["s3:queued"], mode: "draft", waiting: false },
  },
  {
    name: "a cancel-out is a prediction until a fresh snapshot: one that lists the switch clears it",
    events: [
      journal(1, record("s1", "draft", { posted: true })),
      inbox(2, ["s1", "draft"]),
      journal(3, record("s1", "draft", { posted: true }), record("s2", "direct", { posted: true })),
      answer("s2", "direct", "cancelled", 4),
      snapshot(5, [["s1", "draft"]]),
    ],
    expect: { rows: ["s1:queued"], mode: "draft" },
  },
  {
    // R1: order is the server's where it has spoken, this tab's journal after.
    name: "an older applied switch from this tab does not outrank a newer queued one from another device",
    events: [
      journal(1, record("s1", "draft", { posted: true })),
      answer("s1", "draft", "applied", 2),
      inbox(3, ["s3", "direct"]),
    ],
    expect: { rows: ["s1:queued", "s3:queued"], mode: "direct" },
  },
  {
    // F2: s1 is queued with the server, s2 came after it in the journal and its answer says
    // applied before s1's divider arrives. Journal order is known; the answer's state doesn't
    // move s2 ahead of s1.
    name: "keeps this tab's journal order between a queued switch and a newer applied one",
    events: [
      journal(1, record("s1", "draft", { posted: true })),
      inbox(2, ["s1", "draft"]),
      journal(3, record("s1", "draft", { posted: true }), record("s2", "direct", { posted: true })),
      answer("s2", "direct", "applied", 4),
    ],
    expect: { rows: ["s1:queued", "s2:queued"], mode: "direct" },
  },
  {
    // R4: the server can't cancel a switch it already applied, so the later switch is its own row.
    name: "shows a switch made after one that applied but has no divider yet",
    events: [
      journal(1, record("s1", "draft", { posted: true })),
      answer("s1", "draft", "applied", 2),
      journal(3, record("s1", "draft", { posted: true }), record("s2", "direct")),
    ],
    expect: { rows: ["s1:queued", "s2:sending"], mode: "direct" },
  },
  {
    name: "a refused switch shows Retry and a local Withdraw, which settles it",
    events: [
      journal(1, record("s1", "draft", { posted: true, refused: true, failed: true })),
      done("s1", "removed"),
    ],
    expect: { rows: [], mode: "direct" },
  },
  {
    name: "a refused switch offers Withdraw, a lost posted one Retry only",
    events: [
      journal(1, record("s1", "draft", { posted: true, refused: true, failed: true })),
      journal(2, record("s1", "draft", { posted: true, refused: true, failed: true })),
    ],
    expect: { rows: ["s1:failed"], mode: "direct" },
  },
];

it("derives what the writer sees and hears from the sources' events alone", () => {
  for (const scenario of SCENARIOS) {
    let ledger = EMPTY_LEDGER;
    const queued: Mode[] = [];
    const switched: Mode[] = [];
    for (const event of scenario.events) {
      const next = ledgerReducer(ledger, event);
      const change = transitions(ledger, next);
      queued.push(...change.queued);
      switched.push(...change.switched);
      ledger = next;
    }
    const rows = switchRows(ledger).map(
      (row) => `${row.id}:${row.status}${row.awaitingServer ? ":awaiting" : ""}`,
    );
    const label = scenario.name;
    if (scenario.expect.rows) expect(rows, label).toEqual(scenario.expect.rows);
    expect(overlaidMode("direct", ledger), label).toBe(scenario.expect.mode);
    expect(queued, label).toEqual(scenario.expect.heard?.queued ?? []);
    expect(switched, label).toEqual(scenario.expect.heard?.switched ?? []);
    if (scenario.expect.waiting !== undefined)
      expect(proofNeed(ledger) !== null, label).toBe(scenario.expect.waiting);
  }
});
