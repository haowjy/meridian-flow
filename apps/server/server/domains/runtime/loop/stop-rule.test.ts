/**
 * Stop's pure rule, one expanded case per design row whose risk is the decision itself (design A,
 * section 3): which waiting writer messages leave the chat and whether the open execution is
 * cancelled. Rows that need a commit order, repair or a conversation read live in
 * `stop-protocol.db.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { decideStop, type StopFacts, type StopPress, type WriterRow } from "./stop-rule.js";

const M1 = "m1";
const M2 = "m2";
const M3 = "m3";
const row = (id: string, seq: number, extra: Partial<WriterRow> = {}): WriterRow => ({
  id,
  seq,
  delivered: false,
  byExecution: false,
  handedBackBy: null,
  ...extra,
});
const open = (id: string, holder: "assistant" | "compaction" | null = "assistant") => ({
  id,
  holder,
});
const press = (seenThrough: number, seenExecutionId: string | null, mine: string[] = []) =>
  ({ seenThrough, seenExecutionId, mine }) satisfies StopPress;
const decision = (
  cancelExecutionId: string | null,
  handBack: string[],
  answered: string[],
  gone: string[] = [],
) => ({
  cancelExecutionId,
  handBack,
  answered,
  gone,
});

const rows: [string, StopFacts, StopPress, ReturnType<typeof decision>][] = [
  [
    "10 a steer before adoption: E1 cancelled, M2 handed back",
    { execution: open("E1"), receipt: [M1], rows: [row(M1, 1), row(M2, 2)] },
    press(2, "E1"),
    decision("E1", [M2], [M1]),
  ],
  [
    "13 a later message already answered: E1 keeps running for the whole execution",
    {
      execution: open("E1"),
      receipt: [],
      rows: [
        row(M1, 1, { delivered: true, byExecution: true }),
        row(M3, 3, { delivered: true, byExecution: true }),
      ],
    },
    press(1, "E1"),
    decision(null, [], [M1]),
  ],
  [
    "15 a compaction successor holds M2: E1 cancelled, M2 handed back, A's delivery of M1 stands",
    {
      execution: open("E1", "compaction"),
      receipt: [M2],
      rows: [row(M1, 1, { delivered: true, byExecution: true }), row(M2, 2)],
    },
    press(2, "E1"),
    decision("E1", [M2], [M1]),
  ],
  [
    "17 a second tab presses the same scope: the first tab's hand-back is gone, E1 still cancelled",
    {
      execution: open("E1"),
      receipt: [],
      rows: [row(M2, 2, { delivered: true, handedBackBy: "r1" })],
    },
    press(2, "E1"),
    decision("E1", [], [], [M2]),
  ],
  [
    "18 a delayed duplicate after a Retry: E2 took on nothing in the press set and is not the one seen",
    {
      execution: open("E2"),
      receipt: [],
      rows: [row(M1, 1, { delivered: true, byExecution: false })],
    },
    press(1, "E1"),
    decision(null, [], [M1]),
  ],
  [
    "19 a delayed duplicate after a later send: E2 took on M3, which is above the old watermark",
    {
      execution: open("E2"),
      receipt: [M3],
      rows: [row(M1, 1, { delivered: true, handedBackBy: "r1" }), row(M3, 3)],
    },
    press(1, "E1"),
    decision(null, [], [], [M1]),
  ],
  [
    "21 a child report batched with M1: E3 cancelled, the assistant delivers both",
    { execution: open("E3"), receipt: ["report", M1], rows: [row(M1, 1)] },
    press(1, null),
    decision("E3", [], [M1]),
  ],
  [
    "22 an interrupt wait is an open execution the writer saw: cancelled",
    { execution: open("E1"), receipt: [], rows: [] },
    press(0, "E1"),
    decision("E1", [], []),
  ],
  [
    "25a mine, unadopted: handed back though the record predates it",
    { execution: null, receipt: [], rows: [row(M1, 5)] },
    press(4, null, [M1]),
    decision(null, [M1], []),
  ],
  [
    "25b mine, adopted: E cancelled, the assistant delivers M1",
    { execution: open("E1"), receipt: [M1], rows: [row(M1, 5)] },
    press(4, null, [M1]),
    decision("E1", [], [M1]),
  ],
  [
    "25c mine, answered: E cancelled, nothing handed back",
    {
      execution: open("E1"),
      receipt: [],
      rows: [row(M1, 5, { delivered: true, byExecution: true })],
    },
    press(4, null, [M1]),
    decision("E1", [], [M1]),
  ],
  [
    "29 a handoff seed holds no lease: only the writer messages in the press set are handed back",
    { execution: null, receipt: [], rows: [row(M1, 1), row(M2, 2)] },
    press(1, null),
    decision(null, [M1], []),
  ],
];

describe("decideStop", () => {
  it.each(rows)("%s", (_name, facts, pressed, expected) => {
    expect(decideStop(facts, pressed)).toEqual(expected);
  });
});
