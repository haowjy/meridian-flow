/**
 * The run-follow rule as a table: each row feeds facts, obligations, attach,
 * steer and Stop inputs in order and checks settled, the bound turns and the
 * Stop target (plus every cancel the rule asked for) along the way.
 */
import { EventType, type Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  deliveryOf,
  INITIAL_RUN_FOLLOW,
  isBound,
  type RunFollow,
  type RunFollowInput,
  type RunFollowSnapshot,
  stepRunFollow,
  viewRunFollow,
} from "./run-follow";

type Check = {
  settled?: boolean;
  target?: string | null;
  bound?: string[];
  unbound?: string[];
  /** Every cancel the rule asked for so far, in order. */
  cancels?: string[];
};
type Step = RunFollowInput | { kind: "check"; check: Check };

const owe = (...userTurnIds: string[]): Step => ({ kind: "obligations", userTurnIds });
/** A reply start; `position` is the turn's `Turn.position` (null: written before positions). */
const started = (
  runId: string,
  executionId: string,
  reserved: string[] = [],
  position: number | null = null,
): Step => ({
  kind: "event",
  event: {
    type: EventType.RUN_STARTED,
    threadId: "thread_1",
    runId,
    rawEvent: { writeMode: "direct", executionId, reservedForUserTurnIds: reserved, position },
  } as never,
});
const finished = (runId: string): Step => ({
  kind: "event",
  event: { type: EventType.RUN_FINISHED, threadId: "thread_1", runId } as never,
});
const delivered = (
  byTurnId: string | null,
  executionId: string,
  userTurnIds: string[],
  byTurnPosition: number | null = null,
): Step => ({
  kind: "event",
  event: {
    type: EventType.CUSTOM,
    name: "meridian.messages.delivered",
    value: { byTurnId, byTurnPosition, executionId, userTurnIds },
  } as never,
});
const ended = (executionId: string): Step => ({
  kind: "event",
  event: {
    type: EventType.CUSTOM,
    name: "meridian.execution.ended",
    value: { executionId },
  } as never,
});
const steer = (turnId: string): Step => ({ kind: "steer", turnId });
const attach = (executionId: string): Step => ({ kind: "attach", executionId });
const stop: Step = { kind: "stop" };
const refused = (turnId: string): Step => ({
  kind: "cancel-answer",
  turnId,
  status: "already_finished",
});
const check = (expected: Check): Step => ({ kind: "check", check: expected });

type SnapTurn = RunFollowSnapshot["turns"][number];
/** A snapshot turn before `snap` gives it a position. */
type SnapRow = Omit<SnapTurn, "position"> & { position?: number };
/** A reserved turn (assistant or compaction) in a snapshot. */
const reply = (id: string, executionId: string, reserved: string[] = []): SnapRow => ({
  id,
  executionId,
  reservedForUserTurnIds: reserved,
  delivery: null,
});
/** A writer message in a snapshot; `by` names its deliverer once delivered. */
const message = (id: string, by?: string | null): SnapRow => ({
  id,
  executionId: null,
  reservedForUserTurnIds: [],
  delivery: by === undefined ? null : { byTurnId: by },
});
/** A turn no execution reserved (a notice, a switch). */
const notice = (id: string): SnapRow => ({
  id,
  executionId: null,
  reservedForUserTurnIds: [],
  delivery: null,
});
/** At `position`: a snapshot window that does not start at the thread's first turn. */
const at = (position: number, row: SnapRow): SnapRow => ({ ...row, position });
/**
 * A snapshot in transcript order: a row without an explicit position takes the
 * one after its predecessor, as the server's positions run.
 */
const snap = (rows: SnapRow[], openExecutionId: string | null): Step => {
  let position = 0;
  const turns = rows.map((row) => {
    position = row.position ?? position + 1;
    return { ...row, position };
  });
  return { kind: "snapshot", snapshot: { turns, liveState: { openExecutionId } } };
};

function run(steps: Step[]): { follow: RunFollow; cancels: string[] } {
  let follow = INITIAL_RUN_FOLLOW;
  const cancels: string[] = [];
  steps.forEach((step, index) => {
    if (step.kind === "check") {
      const view = viewRunFollow(follow);
      const at = `after step ${index}`;
      const { settled, target, bound = [], unbound = [], cancels: expected } = step.check;
      if (settled !== undefined) expect(view.settled, `${at}: settled`).toBe(settled);
      if (target !== undefined) expect(view.target, `${at}: target`).toBe(target);
      for (const turnId of bound)
        expect(isBound(follow, turnId), `${at}: ${turnId} bound`).toBe(true);
      for (const turnId of unbound)
        expect(isBound(follow, turnId), `${at}: ${turnId} unbound`).toBe(false);
      if (expected) expect(cancels, `${at}: cancels`).toEqual(expected);
      return;
    }
    const result = stepRunFollow(follow, step);
    follow = result.follow;
    if (result.cancel) cancels.push(result.cancel);
  });
  return { follow, cancels };
}

const rows: Array<[name: string, steps: Step[]]> = [
  [
    "I1: a steered message stays owed through A's yield and binds the switch's next execution",
    [
      owe("m1"),
      started("a", "e1", ["m1"]),
      delivered("a", "e1", ["m1"]),
      owe("m2"),
      steer("a"),
      check({ settled: false, target: "a", bound: ["a"] }),
      finished("a"),
      ended("e1"),
      // A yielded to the queued switch with M2 undelivered: still owed.
      check({ settled: false, target: "a" }),
      started("b", "e2", ["m2"]),
      check({ settled: false, target: "b", bound: ["b"] }),
      delivered("b", "e2", ["m2"]),
      owe(),
      check({ settled: false, target: "b" }),
      finished("b"),
      ended("e2"),
      check({ settled: true, target: null, cancels: [] }),
    ],
  ],
  [
    "I2a: a gap snapshot settles A's lost finish",
    [
      owe("m1"),
      started("a", "e1", ["m1"]),
      owe(),
      snap([message("m1", "a"), reply("a", "e1", ["m1"])], null),
      check({ settled: true }),
    ],
  ],
  [
    "I2b: a gap snapshot binds B when A's finish and B's start were lost",
    [
      owe("m1"),
      started("a", "e1", ["m1"]),
      owe("m2"),
      snap(
        [message("m1", "a"), reply("a", "e1", ["m1"]), message("m2"), reply("b", "e1", ["m2"])],
        "e1",
      ),
      check({ settled: false, target: "b", bound: ["a", "b"] }),
    ],
  ],
  [
    "I2c: Stop targets the latest reply of the open execution, past notices",
    [
      owe("m1"),
      started("a", "e1", ["m1"]),
      owe(),
      snap(
        [
          message("m1", "a"),
          reply("a", "e1", ["m1"]),
          notice("n1"),
          reply("b", "e1"),
          notice("n2"),
          reply("c", "e1"),
        ],
        "e1",
      ),
      check({ settled: false, target: "c", bound: ["c"] }),
      stop,
      check({ cancels: ["c"] }),
    ],
  ],
  [
    "I5: a compaction cancelled after A's split ends the execution and leaves its message owed",
    [
      owe("m1", "m2"),
      started("a", "e1", ["m1"]),
      delivered("a", "e1", ["m1"]),
      owe("m2"),
      finished("a"),
      snap(
        [message("m1", "a"), reply("a", "e1", ["m1"]), message("m2"), reply("c", "e1", ["m2"])],
        "e1",
      ),
      check({ settled: false, target: "c" }),
      ended("e1"),
      check({ settled: false, target: null }),
      started("b", "e2", ["m2"]),
      delivered("b", "e2", ["m2"]),
      owe(),
      ended("e2"),
      check({ settled: true }),
    ],
  ],
  [
    "a yield before acknowledgement keeps the message owed for the next execution",
    [
      owe("m1"),
      started("a", "e1", ["m1"]),
      finished("a"),
      ended("e1"),
      check({ settled: false }),
      started("b", "e2", ["m1"]),
      check({ bound: ["b"], target: "b" }),
      delivered("b", "e2", ["m1"]),
      owe(),
      ended("e2"),
      check({ settled: true }),
    ],
  ],
  [
    "a cancel before the first assistant leaves the message owed until the next execution delivers it",
    [
      owe("m1"),
      snap([message("m1"), reply("c", "e1", ["m1"])], "e1"),
      check({ settled: false, target: "c" }),
      stop,
      check({ cancels: ["c"] }),
      ended("e1"),
      check({ settled: false, target: null }),
      started("a", "e2", ["m1"]),
      check({ bound: ["a"], cancels: ["c"] }),
      delivered("a", "e2", ["m1"]),
      owe(),
      ended("e2"),
      check({ settled: true }),
    ],
  ],
  [
    "a Retry attached from the snapshot settles when its execution ends on a cancelled compaction",
    [
      snap([message("m1", "f"), reply("f", "e0", ["m1"]), reply("c", "e5", ["m1"])], "e5"),
      check({ settled: true }),
      attach("e5"),
      check({ settled: false, target: "c" }),
      ended("e5"),
      check({ settled: true, target: null }),
    ],
  ],
  [
    "R1: a replayed start for an already delivered message does not bind while M2 waits",
    [
      owe("m2"),
      started("a", "e1", ["m1"]),
      check({ settled: false, unbound: ["a"], target: null }),
    ],
  ],
  [
    "R2: an unrelated start right after a settled finish is not followed",
    [
      owe("m1"),
      started("a", "e1", ["m1"]),
      delivered("a", "e1", ["m1"]),
      owe(),
      finished("a"),
      ended("e1"),
      check({ settled: true }),
      started("x", "e2"),
      check({ settled: true, unbound: ["x"] }),
    ],
  ],
  [
    "C2: a tab opening after B started follows B from the snapshot and the pending message",
    [
      owe("m2"),
      snap(
        [message("m1", "a"), reply("a", "e1", ["m1"]), message("m2"), reply("b", "e1", ["m2"])],
        "e1",
      ),
      check({ settled: false, target: "b", bound: ["b"] }),
    ],
  ],
  [
    "Stop in the gap waits for the execution that takes the message on",
    [
      owe("m1"),
      started("a", "e1", ["m1"]),
      delivered("a", "e1", ["m1"]),
      owe("m2"),
      finished("a"),
      ended("e1"),
      check({ settled: false, target: null }),
      stop,
      check({ cancels: [] }),
      started("b", "e2", ["m2"]),
      check({ cancels: ["b"] }),
    ],
  ],
  [
    "a typing tab that is not the driving tab keeps Stop in the A-to-B gap",
    [
      // This tab never saw the admission: only the pending projection names M2.
      owe("m2"),
      check({ settled: false, target: null }),
      stop,
      started("b", "e2", ["m2"]),
      check({ bound: ["b"], cancels: ["b"] }),
    ],
  ],
  [
    "TL-D62-n: a message sent after the press retires the waiting Stop (the later action wins)",
    [
      owe("m2"),
      stop,
      owe("m2", "m3"),
      started("b", "e2", ["m3"], 3),
      check({ bound: ["b"], cancels: [] }),
      started("c", "e3", ["m2"], 4),
      check({ settled: false, target: "c", cancels: [] }),
    ],
  ],
  [
    "TL-D62-n: credits shape: owed with nothing running, a press, then a send batches both",
    [
      owe("m1"),
      check({ settled: false, target: null }),
      stop,
      check({ cancels: [] }),
      owe("m1", "m2"),
      started("b", "e1", ["m1", "m2"], 3),
      check({ settled: false, target: "b", bound: ["b"], cancels: [] }),
      delivered("b", "e1", ["m1", "m2"], 3),
      owe(),
      ended("e1"),
      check({ settled: true, cancels: [] }),
    ],
  ],
  [
    "TL-D62-n: a send after a press in the A-to-B gap keeps B running",
    [
      owe("m1"),
      started("a", "e1", ["m1"], 2),
      delivered("a", "e1", ["m1"], 2),
      owe("m2"),
      finished("a"),
      ended("e1"),
      stop,
      check({ target: null, cancels: [] }),
      owe("m2", "m3"),
      started("b", "e2", ["m2", "m3"], 5),
      check({ settled: false, target: "b", cancels: [] }),
    ],
  ],
  [
    "TL-D62-n: a refused press is retired by a later send, not replayed on its successor",
    [
      owe("m1"),
      started("a", "e1", ["m1"], 2),
      delivered("a", "e1", ["m1"], 2),
      owe("m2"),
      steer("a"),
      stop,
      owe("m2", "m3"),
      refused("a"),
      started("b", "e1", ["m2", "m3"], 5),
      check({ settled: false, target: "b", cancels: ["a"] }),
    ],
  ],
  [
    "a refused target lands the Stop on its successor",
    [
      owe("m1"),
      started("a", "e1", ["m1"], 2),
      delivered("a", "e1", ["m1"], 2),
      owe("m2"),
      steer("a"),
      stop,
      check({ cancels: ["a"] }),
      refused("a"),
      check({ cancels: ["a"] }),
      started("b", "e1", ["m2"], 4),
      check({ cancels: ["a", "b"] }),
    ],
  ],
  [
    "a refused target is tried again on a fresh press",
    [
      owe("m1"),
      started("a", "e1", ["m1"]),
      stop,
      refused("a"),
      check({ settled: false, cancels: ["a"] }),
      stop,
      check({ cancels: ["a", "a"] }),
    ],
  ],
  [
    "attach is refused while unsettled",
    [
      owe("m2"),
      attach("e9"),
      started("x", "e9"),
      check({ settled: false, unbound: ["x"], target: null }),
    ],
  ],
  [
    "a resubscribe into an unrelated execution binds nothing of it",
    [
      snap([reply("a", "e1")], "e1"),
      attach("e1"),
      started("x", "e0"),
      check({ settled: false, bound: ["a"], unbound: ["x"], target: "a" }),
      ended("e1"),
      check({ settled: true }),
    ],
  ],
  [
    "A1: a live B learned before a snapshot of A and B stays the target",
    [
      owe("m2"),
      started("b", "e1", ["m2"], 4),
      check({ target: "b" }),
      snap(
        [message("m1", "a"), reply("a", "e1", ["m1"]), message("m2"), reply("b", "e1", ["m2"])],
        "e1",
      ),
      check({ settled: false, target: "b", bound: ["a", "b"] }),
      stop,
      check({ cancels: ["b"] }),
    ],
  ],
  [
    "A1: a snapshot before a replay of A and B keeps B the target",
    [
      owe("m2"),
      snap(
        [message("m1", "a"), reply("a", "e1", ["m1"]), message("m2"), reply("b", "e1", ["m2"])],
        "e1",
      ),
      check({ target: "b" }),
      started("a", "e1", ["m1"], 2),
      check({ target: "b" }),
      started("b", "e1", ["m2"], 4),
      check({ settled: false, target: "b" }),
    ],
  ],
  [
    "A1: an older compaction learned after B does not take the target",
    [
      owe("m1"),
      started("b", "e1", ["m1"], 5),
      delivered("c", "e1", [], 4),
      check({ target: "b" }),
      snap([at(3, message("m1")), at(4, reply("c", "e1", ["m1"])), reply("b", "e1", ["m1"])], "e1"),
      check({ settled: false, target: "b", bound: ["b", "c"] }),
    ],
  ],
  [
    "A1: a turn of unknown position is the target only when nothing running is positioned",
    [
      owe("m1"),
      started("a", "e1", ["m1"]),
      check({ target: "a" }),
      started("b", "e1", ["m1"], 4),
      check({ target: "b" }),
    ],
  ],
];

describe("run-follow rule", () => {
  it.each(rows)("%s", (_name, steps) => {
    run(steps);
  });
});

describe("run facts", () => {
  it("reads a message's deliverer from stream and snapshot facts alike", () => {
    const { follow } = run([
      delivered("a", "e1", ["m1"]),
      snap([message("m2", "b"), reply("b", "e2", ["m2"])], null),
    ]);
    expect(deliveryOf(follow.facts, "m1")).toEqual({ byTurnId: "a", executionId: "e1" });
    expect(deliveryOf(follow.facts, "m2")).toEqual({ byTurnId: "b", executionId: "e2" });
  });
});

// Keeps the snapshot helper's Turn fields in step with the contract.
export type _SnapTurnIsTurn = SnapTurn extends Pick<Turn, keyof SnapTurn> ? true : never;
