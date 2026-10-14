/**
 * The switch display as a table through the run-state slice's own reducer. Each scenario is a list of
 * server facts (a snapshot, run-state frames, answers, each a whole record carrying its
 * version) and this device's intents, and asserts the toolbar mode and the rows after every
 * event. The scenarios are the reviewers' own scripts from five rounds of #760 review (R1, R4,
 * F1 to F4, B1 from rp1, rp3 and rp4, N2). Versions read `J * 1000 + index` like the stream's; an
 * answer's version is the journal head `J * 1000 + 999`.
 */
import type { RunState } from "@meridian/contracts/threads";
import { expect, it } from "vitest";
import type { JournalSwitch } from "@/client/chat-submissions/owner";
import {
  INITIAL_RUN_STATE_SLICE,
  type RunStateAction,
  type RunStateSlice,
  reduceRunState,
  switchDisplay,
} from "./run-state-slice";

type Mode = "draft" | "direct";
type Queued = [id: string, mode: Mode];
const at = (j: number, index = 0) => String(j * 1000 + index);
const head = (j: number) => at(j, 999);

const item = ([id, mode]: Queued) =>
  ({
    id,
    intent: "control",
    seq: 1,
    control: { kind: "write_mode", mode },
    provenance: { kind: "writer" },
    deliveryState: "waiting",
  }) as never;
const runState = (version: string, mode: Mode, queued: Queued[]): RunState => ({
  version,
  items: queued.map(item),
  sentThrough: 0,
  execution: null,
  mode,
  blocked: null,
});

type Event =
  | { snapshot: number; mode: Mode; queued?: Queued[] }
  | { record: string; mode: Mode; queued?: Queued[] }
  | { switched: string; id: string }
  | { choose: string; mode: Mode; order: number; failed?: boolean; awaiting?: boolean }
  | { answer: string; j: number; mode: Mode; queued?: Queued }
  | { stamp: number; mode: Mode; queued?: Queued }
  | { drop: string }
  | { withdraw: string; failed?: boolean }
  | { withdrawn: string; j: number; mode: Mode; queued?: Queued };

const snapshot = (j: number, mode: Mode, ...queued: Queued[]): Event => ({
  snapshot: j,
  mode,
  queued,
});
/** A `meridian.run_state` frame: the whole record at its stream version. */
const record = (seq: string, mode: Mode, ...queued: Queued[]): Event => ({
  record: seq,
  mode,
  queued,
});
/** A `meridian.write_mode.switched` frame: the server's answer for its control, not a record. */
const switched = (seq: string, id = "s1"): Event => ({ switched: seq, id });
const choose = (id: string, mode: Mode, order: number): Event => ({ choose: id, mode, order });
const answer = (id: string, j: number, mode: Mode, queued?: Queued): Event => ({
  answer: id,
  j,
  mode,
  queued,
});

type Journal = Record<string, JournalSwitch>;
type Harness = { state: RunStateSlice; journal: Journal };

const answerFacts = (j: number, mode: Mode, queued?: Queued) => ({
  runState: runState(head(j), mode, queued ? [queued] : []),
  at: 0,
});

/** One event through the reducer the hook runs, with the journal the hook would be handed. */
function step({ state, journal }: Harness, event: Event): Harness {
  const dispatch = (action: RunStateAction, next = journal) => ({
    state: reduceRunState(state, action),
    journal: next,
  });
  const ingest = (next: Journal) =>
    dispatch({ type: "journal", switches: Object.values(next) }, next);
  if ("snapshot" in event)
    return dispatch({
      type: "snapshot",
      runState: runState(head(event.snapshot), event.mode, event.queued ?? []),
    });
  if ("record" in event)
    return dispatch({
      type: "record",
      runState: runState(event.record, event.mode, event.queued ?? []),
    });
  if ("switched" in event)
    return dispatch({
      type: "switched",
      seq: event.switched,
      controlId: event.id,
      turnId: `divider-${event.id}`,
      mode: "direct",
    });
  if ("choose" in event)
    return ingest({
      ...journal,
      [event.choose]: {
        id: event.choose,
        mode: event.mode,
        seq: event.order,
        posted: event.awaiting === true,
        refused: false,
        failed: event.failed === true,
        answer: null,
      },
    });
  if ("answer" in event)
    return ingest({
      ...journal,
      [event.answer]: {
        ...journal[event.answer],
        answer: answerFacts(event.j, event.mode, event.queued),
      } as JournalSwitch,
    });
  if ("stamp" in event)
    // A passive tab: the stamp is in the journal, and this tab never chose the switch.
    return ingest({
      ...journal,
      [`stamp${event.stamp}`]: {
        id: `stamp${event.stamp}`,
        mode: event.mode,
        seq: 0,
        posted: true,
        refused: false,
        failed: false,
        answer: answerFacts(event.stamp, event.mode, event.queued),
      },
    });
  if ("drop" in event) {
    const { [event.drop]: _gone, ...rest } = journal;
    return ingest(rest);
  }
  if ("withdraw" in event)
    return dispatch({ type: "withdraw", id: event.withdraw, failed: event.failed });
  return dispatch({
    type: "withdrawn",
    id: event.withdrawn,
    runState: answerFacts(event.j, event.mode, event.queued).runState,
  });
}

/** Rows read `id:status`, with `:awaiting` for a switch the server may hold. */
const SCENARIOS: {
  name: string;
  steps: [Event, mode: Mode, rows: string[]][];
  /** The intents (`kind:id`) the view still holds after the last step, where lifecycle is the risk. */
  retained?: string[];
  /** The queued switches announced as news, in order. */
  news?: string[];
}[] = [
  {
    name: "R1: a delayed cancel-out answer says nothing about a switch queued after it",
    steps: [
      [snapshot(1, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
      [choose("s2", "direct", 2), "direct", []],
      [record(at(3), "direct"), "direct", []],
      // Another device queues s3. Until s2's answer arrives its effect is unknown, so the
      // fold still lays it over s3: the transient is bounded by the answer, not by a proof.
      [record(at(4), "direct", ["s3", "draft"]), "direct", []],
      [answer("s2", 3, "direct"), "draft", ["s3:queued"]],
    ],
  },
  {
    name: "R4: an applied switch is server mode and cannot be folded away by the next one",
    steps: [
      [snapshot(1, "direct"), "direct", []],
      [choose("s1", "draft", 1), "draft", ["s1:sending"]],
      [answer("s1", 2, "draft"), "draft", []],
      [choose("s2", "direct", 2), "direct", ["s2:sending"]],
    ],
  },
  {
    name: "F1 and N2: an older snapshot, however it was joined, retires nothing and rewrites nothing",
    steps: [
      [snapshot(5, "direct"), "direct", []],
      [choose("s1", "draft", 1), "draft", ["s1:sending"]],
      [snapshot(5, "direct"), "draft", ["s1:sending"]],
      [answer("s1", 6, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
      [snapshot(5, "direct"), "draft", ["s1:queued"]],
    ],
  },
  {
    name: "#3 and N3: a delayed divider cannot rewrite a mode a newer answer set",
    steps: [
      [snapshot(1, "direct"), "direct", []],
      [choose("s1", "draft", 1), "draft", ["s1:sending"]],
      [choose("s2", "direct", 2), "direct", []],
      [answer("s1", 2, "draft"), "direct", ["s2:sending"]],
      [answer("s2", 3, "direct"), "direct", []],
      [switched(at(2)), "direct", []],
    ],
  },
  {
    name: "F2 and F3: the server's order wins, whatever order the answer and the frames arrive in",
    steps: [
      [snapshot(1, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
      [choose("s2", "direct", 2), "direct", []],
      [answer("s2", 3, "direct"), "direct", []],
      // s1 applied before s2 cancelled nothing: its late frames are older than the answer.
      [switched(at(2)), "direct", []],
      [record(at(2, 1), "direct", ["s1", "draft"]), "direct", []],
    ],
  },
  {
    name: "F4: switches chosen in the same instant fold by id, as the driver drains them",
    steps: [
      [snapshot(1, "direct"), "direct", []],
      [choose("z", "direct", 1), "direct", []],
      [choose("a", "draft", 1), "direct", []],
      [answer("a", 2, "direct", ["a", "draft"]), "direct", []],
    ],
  },
  {
    name: "B1 (rp1): the reply-end apply never shows the old mode, or the applied row, between the divider and the inbox",
    steps: [
      [snapshot(1, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
      // The apply removed the queued row and set the mode in one transaction, and the record
      // that follows holds both: no record shows the new mode beside the row that caused it.
      [switched(at(2)), "draft", ["s1:queued"]],
      [record(at(2, 1), "draft"), "draft", []],
    ],
  },
  {
    name: "B1 (rp3) and B1-residual (rp4): a cancelled row stays gone against a stale inbox frame",
    steps: [
      [snapshot(1, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
      [choose("s2", "direct", 2), "direct", []],
      [answer("s2", 3, "direct"), "direct", []],
      [record(at(2), "direct", ["s1", "draft"]), "direct", []],
    ],
  },
  {
    name: "#4: a passive tab reads the stamp as a server fact and does not revert",
    steps: [
      [snapshot(1, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
      [{ stamp: 3, mode: "direct" }, "direct", []],
      [snapshot(2, "direct", ["s1", "draft"]), "direct", []],
    ],
  },
  {
    name: "O11: the choosing tab holds its row until a driving tab's stamp arrives",
    steps: [
      [snapshot(1, "direct"), "direct", []],
      [choose("s1", "draft", 1), "draft", ["s1:sending"]],
      [snapshot(1, "direct"), "draft", ["s1:sending"]],
      [answer("s1", 2, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
    ],
  },
  {
    name: "a switch made before the first record shows at once, over the thread row's mode",
    steps: [
      [choose("s1", "draft", 1), "draft", ["s1:sending"]],
      [snapshot(2, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
    ],
  },
  {
    name: "a lost response keeps the row as failed with Retry only, a refusal lets Withdraw drop it",
    steps: [
      [snapshot(1, "direct"), "direct", []],
      [
        { choose: "s1", mode: "draft", order: 1, failed: true, awaiting: true },
        "direct",
        ["s1:failed:awaiting"],
      ],
      [
        { choose: "s2", mode: "draft", order: 2, failed: true },
        "direct",
        ["s1:failed:awaiting", "s2:failed"],
      ],
      [{ drop: "s2" }, "direct", ["s1:failed:awaiting"]],
    ],
  },
  {
    name: "Withdraw hides the queued row at once, and a failed one puts the failure on it",
    steps: [
      [snapshot(1, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
      [{ withdraw: "s1" }, "direct", []],
      [{ withdraw: "s1", failed: true }, "draft", ["s1:withdraw_failed"]],
      [{ withdraw: "s1" }, "direct", []],
      [{ withdrawn: "s1", j: 2, mode: "direct" }, "direct", []],
      [record(at(2), "direct"), "direct", []],
    ],
    retained: [],
  },
  {
    name: "a Withdraw on a quiet chat retires on its own answer, with no later record to reach it",
    steps: [
      [snapshot(1, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
      [{ withdraw: "s1" }, "direct", []],
      // The withdrawal's own frame is at J*1000; its answer is the head, J*1000+999.
      [record(at(2), "direct"), "direct", []],
      [{ withdrawn: "s1", j: 2, mode: "direct" }, "direct", []],
    ],
    retained: [],
  },
  {
    name: "a switched frame answers its control: a delayed HTTP answer cannot ghost after a switch back",
    steps: [
      [snapshot(1, "direct"), "direct", []],
      [choose("s1", "draft", 1), "draft", ["s1:sending"]],
      // The frame answers s1 at its seq; the record of the same commit follows and retires it.
      [switched(at(2)), "draft", ["s1:sending"]],
      [record(at(2, 1), "draft"), "draft", []],
      // Another device switches back before s1's own answer arrives.
      [switched(at(3), "s9"), "draft", []],
      [record(at(3, 1), "direct"), "direct", []],
      [answer("s1", 2, "draft"), "direct", []],
    ],
  },
  {
    name: "a record that arrives before the snapshot is the first record, and an older snapshot cannot replace it",
    steps: [
      [record(at(2), "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
      [snapshot(1, "direct"), "draft", ["s1:queued"]],
      [switched(at(3)), "draft", ["s1:queued"]],
      [record(at(3, 1), "draft"), "draft", []],
    ],
  },
  {
    name: "answer evidence outlives a retired intent: a journal rebuild does not bring a ghost back",
    steps: [
      [snapshot(1, "direct"), "direct", []],
      [choose("s1", "draft", 1), "draft", ["s1:sending"]],
      [switched(at(2)), "draft", ["s1:sending"]],
      [record(at(2, 1), "draft"), "draft", []],
      [switched(at(3), "s9"), "draft", []],
      [record(at(3, 1), "direct"), "direct", []],
      // The journal still holds s1 unstamped; adding s2 re-adds it.
      [choose("s2", "draft", 2), "draft", ["s2:sending"]],
    ],
    retained: ["switch:s2"],
  },
  {
    name: "answer evidence arrives before the intent: a frame ahead of the journal entry is not lost",
    steps: [
      [snapshot(1, "direct"), "direct", []],
      [switched(at(2)), "direct", []],
      [record(at(2, 1), "draft"), "draft", []],
      [switched(at(3), "s9"), "draft", []],
      [record(at(3, 1), "direct"), "direct", []],
      [choose("s1", "draft", 1), "direct", []],
    ],
    retained: [],
  },
  {
    name: "a lost response whose switch applied: the frame answers it, so no failed row and no ghost remain",
    steps: [
      [snapshot(1, "direct"), "direct", []],
      [
        { choose: "s1", mode: "draft", order: 1, failed: true, awaiting: true },
        "direct",
        ["s1:failed:awaiting"],
      ],
      [switched(at(2)), "direct", ["s1:failed:awaiting"]],
      [record(at(2, 1), "draft"), "draft", []],
      [switched(at(3), "s9"), "draft", []],
      [record(at(3, 1), "direct"), "direct", []],
      [choose("s2", "direct", 2), "direct", []],
    ],
    retained: ["switch:s2"],
  },
  {
    name: "a switched frame leaves no applied control queued: the next choice folds against the applied mode",
    steps: [
      [snapshot(1, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
      [switched(at(2)), "draft", ["s1:queued"]],
      [record(at(2, 1), "draft"), "draft", []],
      [choose("s2", "direct", 2), "direct", ["s2:sending"]],
    ],
  },
  {
    name: "the first record and a newer snapshot are not news; a live inbox frame is, once",
    steps: [
      [snapshot(1, "direct", ["s0", "draft"]), "draft", ["s0:queued"]],
      [snapshot(2, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
      [record(at(3), "direct", ["s3", "draft"]), "draft", ["s3:queued"]],
      [record(at(3), "direct", ["s3", "draft"]), "draft", ["s3:queued"]],
    ],
    news: ["s3"],
  },
  {
    name: "S1: a stamp left over from before a reload is evidence, never a record: it makes no row and no news",
    steps: [
      [{ stamp: 3, mode: "draft", queued: ["s1", "draft"] }, "direct", []],
      // The first record is whatever carrier brings one first, and what it holds is not news.
      [record(at(4), "draft"), "draft", []],
      [snapshot(4, "draft"), "draft", []],
    ],
    retained: [],
    news: [],
  },
  {
    name: "S2: an instant switch back keeps the writer's last pick on screen through the first answer",
    steps: [
      [snapshot(1, "direct"), "direct", []],
      [choose("s1", "draft", 1), "draft", ["s1:sending"]],
      [choose("s2", "direct", 2), "direct", []],
      // The first switch enqueues, applies on the idle chat and answers, while s2 waits behind it.
      [record(at(2), "direct", ["s1", "draft"]), "direct", []],
      [switched(at(2, 1)), "direct", []],
      [record(at(2, 2), "draft"), "direct", ["s2:sending"]],
      [answer("s1", 2, "draft"), "direct", ["s2:sending"]],
      // Then s2 enqueues, applies and answers.
      [record(at(3), "draft", ["s2", "direct"]), "direct", ["s2:queued"]],
      [switched(at(3, 1), "s2"), "direct", ["s2:queued"]],
      [record(at(3, 2), "direct"), "direct", []],
      [answer("s2", 3, "direct"), "direct", []],
    ],
    retained: [],
  },
  {
    name: "a reload with a queued switch shows it queued, and its answer from the journal stamp retires nothing twice",
    steps: [
      [snapshot(4, "direct", ["s1", "draft"]), "draft", ["s1:queued"]],
      [{ stamp: 3, mode: "direct" }, "draft", ["s1:queued"]],
    ],
  },
];

it("derives the switch rows and toolbar mode from server facts at one seq and unanswered intents", () => {
  for (const scenario of SCENARIOS) {
    let harness: Harness = { state: INITIAL_RUN_STATE_SLICE, journal: {} };
    scenario.steps.forEach(([event, mode, rows], index) => {
      harness = step(harness, event);
      const shown = switchDisplay(harness.state.view, "direct");
      const label = `${scenario.name} (step ${index + 1})`;
      expect(shown.mode, label).toBe(mode);
      expect(
        shown.rows.map((row) => `${row.id}:${row.status}${row.awaitingServer ? ":awaiting" : ""}`),
        label,
      ).toEqual(rows);
    });
    if (scenario.news)
      expect(
        harness.state.news.map((entry) => entry.id),
        `${scenario.name} (news)`,
      ).toEqual(scenario.news);
    if (scenario.retained)
      expect(
        harness.state.view.intents.map((intent) => `${intent.kind}:${intent.id}`),
        `${scenario.name} (retained)`,
      ).toEqual(scenario.retained);
  }
});
