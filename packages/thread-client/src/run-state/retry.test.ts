import type { Turn } from "@meridian/contracts/protocol";
import type { RunState } from "@meridian/contracts/threads";
import { expect, it } from "vitest";
import { type RetryEntry, reconcileRetries } from "./retry";
import { INITIAL_RUN_STATE_VIEW, receiveRecord } from "./run-state-view";

const record = (version: string, executionId: string | null): RunState => ({
  version,
  items: [],
  sentThrough: 0,
  execution: executionId ? { executionId, currentTurnId: "x" } : null,
  mode: "direct",
  blocked: null,
});
const turn = (id: string, retryOf?: string) =>
  ({ id, role: "assistant", metadata: retryOf ? { retryOf } : null }) as unknown as Turn;
const entry = (over: Partial<RetryEntry> = {}): RetryEntry => ({
  id: "r2",
  from: "r1",
  executionId: "e2",
  answerVersion: "5999",
  ...over,
});
const reconcile = (
  entries: RetryEntry[],
  storedTurns: Turn[],
  view = receiveRecord(INITIAL_RUN_STATE_VIEW, record("5999", "e2")),
  supersedes = true,
) => reconcileRetries({ entries, storedTurns, view, supersedes });

it("keeps a Retry until its turn is stored and named, or its reservation ended without one", () => {
  // Risk: a stand-in that never leaves, one that leaves early, or the failed reply drawn twice.
  const open = reconcile([entry()], [turn("r1")]);
  expect(open.standIns).toHaveLength(1);
  expect([...open.hidden]).toEqual(["r1"]);
  // The reply is stored but no turn names its target yet: only a hidden target, no stand-in.
  const stored = reconcile([entry()], [turn("r1"), turn("r2")]);
  expect(stored.remaining).toHaveLength(1);
  expect(stored.standIns).toHaveLength(0);
  expect([...stored.hidden]).toEqual(["r1"]);
  // A stored compaction turn carries retryOf ahead of the reply: that settles it too.
  expect(reconcile([entry()], [turn("r1"), turn("c1", "r1"), turn("r2")]).remaining).toEqual([]);
  // The record, at or after the answer, shows no execution or another: nothing will come.
  const ended = receiveRecord(INITIAL_RUN_STATE_VIEW, record("6999", null));
  expect(reconcile([entry()], [turn("r1")], ended).remaining).toEqual([]);
  // An older record, or an answer that never arrived, retires nothing.
  const older = receiveRecord(INITIAL_RUN_STATE_VIEW, record("4999", null));
  expect(reconcile([entry()], [turn("r1")], older).remaining).toHaveLength(1);
  expect(reconcile([entry({ answerVersion: null })], [turn("r1")], ended).remaining).toHaveLength(
    1,
  );
  // A handoff brief's Retry replaces nothing: the stored turn settles it and nothing is hidden.
  const brief = reconcile(
    [entry({ executionId: null, answerVersion: null })],
    [],
    undefined,
    false,
  );
  expect(brief.hidden.size).toBe(0);
  expect(reconcile([entry()], [turn("r2")], undefined, false).remaining).toEqual([]);
});
