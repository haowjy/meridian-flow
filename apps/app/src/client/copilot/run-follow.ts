/**
 * The run-follow rule: which executions a client follows, when it is settled,
 * and what Stop targets, as a pure function of server-decided facts.
 *
 * Facts (`RunFacts`) are write-once, so stream events and HTTP snapshots merge
 * into them by union: a turn's execution and the messages it was reserved for,
 * a message's deliverer, and ended executions. The caller supplies its
 * obligations: the message ids it waits on (the app passes the writer messages
 * of the chat's pending inbox; a CLI passes the one message it sent).
 *
 * ```text
 * owed      = obligations without a delivery fact
 * tracked   = every message owed since the last settle
 * followed  = executions that took on (reserved a turn for) or delivered a tracked message
 *             ∪ attached (an open execution attached while settled)
 * running   = followed without an end fact
 * settled   = owed = ∅ ∧ running = ∅          (settling clears tracked, attached, steer, Stop)
 * target    = the running executions' turn with the highest server position
 *             ?? (owed ≠ ∅ ? steer : none)
 * ```
 *
 * "Latest" is `Turn.position`, the server's write-once insertion order, from
 * snapshots, `RUN_STARTED` and `messages.delivered`; never the order this client
 * happened to learn turns in, so two tabs with the same facts agree. A turn of
 * unknown position (history written before positions were recorded) is a target
 * only when no running turn has a position.
 *
 * A Stop press cancels the target. With no target, or when the cancel is
 * refused, it becomes an intent recording the messages owed at the press; the
 * intent lands only on a target whose execution took on or delivered one of
 * them, and never again on the turn that refused it. A fresh press retries.
 * Messages that become owed after the press join the intent's `owedAfterPress`;
 * the intent never lands on an execution serving one of them (the later send
 * wins), but still lands on separate work serving only press-time messages.
 *
 * No React, store, journal or transport imports: this module moves to
 * `packages/` unchanged.
 */
import {
  type AGUIEvent,
  type CancelTurnResponse,
  EventType,
  EXECUTION_ENDED_EVENT,
  MESSAGES_DELIVERED_EVENT,
  readExecutionEnded,
  readMessagesDelivered,
  readRunStartedMeta,
  type SnapshotLiveState,
  type Turn,
} from "@meridian/contracts/protocol";

/** What a reserved turn records: its execution, the messages it was reserved for (a hint), and its position. */
export type TurnFact = {
  executionId: string | null;
  reservedForUserTurnIds: readonly string[];
  /** `Turn.position`: the thread's insertion order; null when unknown. */
  position: number | null;
};

/** A delivered message: the turn that delivered it and that turn's execution, null when unknown. */
export type DeliveryFact = { byTurnId: string | null; executionId: string | null };

/** Merged, write-once run identity facts for one thread. */
export type RunFacts = {
  /** Reserved turns by id. Iteration order carries no meaning. */
  turns: ReadonlyMap<string, TurnFact>;
  /** Delivered messages (= user turn ids). */
  deliveries: ReadonlyMap<string, DeliveryFact>;
  /** Executions that ended. */
  ended: ReadonlySet<string>;
};

/** The snapshot fields the facts read; a `ThreadSnapshotResponse` satisfies it. */
export type RunFollowSnapshot = {
  turns: readonly Pick<
    Turn,
    "id" | "executionId" | "reservedForUserTurnIds" | "delivery" | "position"
  >[];
  liveState: Pick<SnapshotLiveState, "openExecutionId">;
};

/** A Stop press still in force. */
export type StopState = {
  /** The messages owed at the press: the only work this Stop may land on. */
  owedAtPress: ReadonlySet<string>;
  /** Messages owed after the press: an execution serving any of them is never cancelled by it. */
  owedAfterPress: ReadonlySet<string>;
  /** The last turn whose cancel was refused; the intent skips it until a fresh press. */
  refusedTurnId: string | null;
  /** A cancel sent and not yet answered; while set, the intent waits for its answer. */
  inFlightTurnId: string | null;
};

export type RunFollow = {
  facts: RunFacts;
  /** The caller's latest obligations. */
  obligations: ReadonlySet<string>;
  /** Messages owed at some point since the last settle. */
  tracked: ReadonlySet<string>;
  /** An open execution attached while settled. */
  attached: string | null;
  /** The live reply a message was steered into: a Stop hint, bound while owed. */
  steer: string | null;
  stop: StopState | null;
};

export type RunFollowInput =
  /** A stream event; only run identity events change the facts. */
  | { kind: "event"; event: AGUIEvent }
  | { kind: "snapshot"; snapshot: RunFollowSnapshot }
  /** Replaces the obligations. */
  | { kind: "obligations"; userTurnIds: Iterable<string> }
  | { kind: "steer"; turnId: string }
  /** Follow an open execution; refused while unsettled. */
  | { kind: "attach"; executionId: string }
  | { kind: "stop" }
  | { kind: "cancel-answer"; turnId: string; status: CancelTurnResponse["status"] };

export type RunFollowView = {
  settled: boolean;
  owed: ReadonlySet<string>;
  /** Followed executions: their turns' stream events apply. */
  boundExecutions: ReadonlySet<string>;
  /** Turns bound outside an execution (the steer hint). */
  boundTurns: ReadonlySet<string>;
  /** Followed executions with no end fact. */
  running: ReadonlySet<string>;
  target: string | null;
};

export type RunFollowStep = {
  follow: RunFollow;
  /** A turn to cancel now. */
  cancel: string | null;
};

const NONE: ReadonlySet<string> = new Set();

export const EMPTY_RUN_FACTS: RunFacts = {
  turns: new Map(),
  deliveries: new Map(),
  ended: new Set(),
};

export const INITIAL_RUN_FOLLOW: RunFollow = {
  facts: EMPTY_RUN_FACTS,
  obligations: NONE,
  tracked: NONE,
  attached: null,
  steer: null,
  stop: null,
};

function withTurn(turns: Map<string, TurnFact>, turnId: string, fact: TurnFact): boolean {
  const known = turns.get(turnId);
  if (!known) {
    turns.set(turnId, fact);
    return true;
  }
  const executionId = known.executionId ?? fact.executionId;
  const position = known.position ?? fact.position;
  const added = fact.reservedForUserTurnIds.filter(
    (id) => !known.reservedForUserTurnIds.includes(id),
  );
  if (executionId === known.executionId && position === known.position && added.length === 0)
    return false;
  turns.set(turnId, {
    executionId,
    reservedForUserTurnIds: [...known.reservedForUserTurnIds, ...added],
    position,
  });
  return true;
}

function withDelivery(
  deliveries: Map<string, DeliveryFact>,
  userTurnId: string,
  fact: DeliveryFact,
): boolean {
  const known = deliveries.get(userTurnId);
  const next = {
    byTurnId: known?.byTurnId ?? fact.byTurnId,
    executionId: known?.executionId ?? fact.executionId,
  };
  if (known && known.byTurnId === next.byTurnId && known.executionId === next.executionId)
    return false;
  deliveries.set(userTurnId, next);
  return true;
}

/** Merge one stream event; anything but a run identity event returns `facts` unchanged. */
export function mergeStreamEvent(facts: RunFacts, event: AGUIEvent): RunFacts {
  if (event.type === EventType.RUN_STARTED) {
    const { executionId, reservedForUserTurnIds, position } = readRunStartedMeta(event.rawEvent);
    const turns = new Map(facts.turns);
    return withTurn(turns, event.runId, { executionId, reservedForUserTurnIds, position })
      ? { ...facts, turns }
      : facts;
  }
  if (event.type !== EventType.CUSTOM) return facts;
  if (event.name === MESSAGES_DELIVERED_EVENT) {
    const value = readMessagesDelivered(event.value);
    if (!value) return facts;
    const { byTurnId, executionId, byTurnPosition } = value;
    const turns = new Map(facts.turns);
    const deliveries = new Map(facts.deliveries);
    // The deliverer is one of the execution's turns even when no start named it (a placeholder).
    let changed =
      byTurnId !== null && executionId !== null
        ? withTurn(turns, byTurnId, {
            executionId,
            reservedForUserTurnIds: [],
            position: byTurnPosition,
          })
        : false;
    for (const userTurnId of value.userTurnIds)
      changed = withDelivery(deliveries, userTurnId, { byTurnId, executionId }) || changed;
    return changed ? { ...facts, turns, deliveries } : facts;
  }
  if (event.name === EXECUTION_ENDED_EVENT) {
    const value = readExecutionEnded(event.value);
    if (!value || facts.ended.has(value.executionId)) return facts;
    return { ...facts, ended: new Set(facts.ended).add(value.executionId) };
  }
  return facts;
}

/**
 * Merge an HTTP snapshot. Turns and deliveries are read in one consistent
 * transaction with `openExecutionId`, so every execution on its turns other
 * than the open one has ended.
 */
export function mergeSnapshot(facts: RunFacts, snapshot: RunFollowSnapshot): RunFacts {
  const turns = new Map(facts.turns);
  const deliveries = new Map(facts.deliveries);
  const ended = new Set(facts.ended);
  let changed = false;
  for (const turn of snapshot.turns) {
    // Turns from before run identity carry no execution: unknown, never followed.
    if (!turn.executionId) continue;
    changed =
      withTurn(turns, turn.id, {
        executionId: turn.executionId,
        reservedForUserTurnIds: turn.reservedForUserTurnIds ?? [],
        position: turn.position ?? null,
      }) || changed;
    if (turn.executionId !== snapshot.liveState.openExecutionId && !ended.has(turn.executionId)) {
      ended.add(turn.executionId);
      changed = true;
    }
  }
  for (const turn of snapshot.turns) {
    if (!turn.delivery) continue;
    const { byTurnId } = turn.delivery;
    changed =
      withDelivery(deliveries, turn.id, {
        byTurnId,
        executionId: byTurnId ? (turns.get(byTurnId)?.executionId ?? null) : null,
      }) || changed;
  }
  // Unchanged facts keep their identity: readers re-render only on news.
  return changed ? { turns, deliveries, ended } : facts;
}

/** Which turn (and execution) delivered a message, when the facts know it was delivered. */
export function deliveryOf(facts: RunFacts, userTurnId: string): DeliveryFact | undefined {
  const delivery = facts.deliveries.get(userTurnId);
  if (!delivery || delivery.executionId !== null || delivery.byTurnId === null) return delivery;
  return {
    byTurnId: delivery.byTurnId,
    executionId: facts.turns.get(delivery.byTurnId)?.executionId ?? null,
  };
}

function owedOf(follow: RunFollow): ReadonlySet<string> {
  const owed = new Set<string>();
  for (const id of follow.obligations) if (!follow.facts.deliveries.has(id)) owed.add(id);
  return owed;
}

/** Executions that took on (reserved a turn for) or delivered one of `messages`. */
function executionsServing(facts: RunFacts, messages: ReadonlySet<string>): Set<string> {
  const executions = new Set<string>();
  if (messages.size === 0) return executions;
  for (const fact of facts.turns.values()) {
    if (fact.executionId && fact.reservedForUserTurnIds.some((id) => messages.has(id)))
      executions.add(fact.executionId);
  }
  for (const id of messages) {
    const executionId = deliveryOf(facts, id)?.executionId;
    if (executionId) executions.add(executionId);
  }
  return executions;
}

/**
 * The running executions' turn with the highest position. Unknown positions
 * have no order; one is chosen (by id, so every client picks the same) only
 * when nothing running is positioned. Any turn of a live execution cancels it.
 */
function latestRunningTurn(facts: RunFacts, running: ReadonlySet<string>): string | null {
  let latest: { turnId: string; position: number } | null = null;
  let unpositioned: string | null = null;
  if (running.size === 0) return null;
  for (const [turnId, fact] of facts.turns) {
    if (!fact.executionId || !running.has(fact.executionId)) continue;
    if (fact.position === null) {
      if (unpositioned === null || turnId < unpositioned) unpositioned = turnId;
    } else if (latest === null || fact.position > latest.position) {
      latest = { turnId, position: fact.position };
    }
  }
  return latest?.turnId ?? unpositioned;
}

export function viewRunFollow(follow: RunFollow): RunFollowView {
  const { facts } = follow;
  const owed = owedOf(follow);
  const followed = executionsServing(facts, follow.tracked);
  if (follow.attached) followed.add(follow.attached);
  const running = new Set([...followed].filter((id) => !facts.ended.has(id)));
  let target = latestRunningTurn(facts, running);
  if (target === null && owed.size > 0) target = follow.steer;
  return {
    settled: owed.size === 0 && running.size === 0,
    owed,
    boundExecutions: followed,
    boundTurns: follow.steer ? new Set([follow.steer]) : NONE,
    running,
    target,
  };
}

/** Whether a turn's stream events belong to what this client follows. */
export function isBound(follow: RunFollow, turnId: string, view = viewRunFollow(follow)): boolean {
  if (view.boundTurns.has(turnId)) return true;
  const executionId = follow.facts.turns.get(turnId)?.executionId;
  return executionId != null && view.boundExecutions.has(executionId);
}

function apply(follow: RunFollow, input: RunFollowInput): RunFollowStep {
  switch (input.kind) {
    case "event": {
      const facts = mergeStreamEvent(follow.facts, input.event);
      return { follow: facts === follow.facts ? follow : { ...follow, facts }, cancel: null };
    }
    case "snapshot": {
      const facts = mergeSnapshot(follow.facts, input.snapshot);
      return { follow: facts === follow.facts ? follow : { ...follow, facts }, cancel: null };
    }
    case "obligations":
      return { follow: { ...follow, obligations: new Set(input.userTurnIds) }, cancel: null };
    case "steer":
      return { follow: { ...follow, steer: input.turnId }, cancel: null };
    case "attach":
      return viewRunFollow(follow).settled
        ? { follow: { ...follow, attached: input.executionId }, cancel: null }
        : { follow, cancel: null };
    case "stop": {
      const view = viewRunFollow(follow);
      return {
        follow: {
          ...follow,
          stop: {
            owedAtPress: view.owed,
            owedAfterPress: NONE,
            refusedTurnId: null,
            inFlightTurnId: view.target,
          },
        },
        cancel: view.target,
      };
    }
    case "cancel-answer": {
      const { stop } = follow;
      if (!stop || stop.inFlightTurnId !== input.turnId) return { follow, cancel: null };
      return {
        follow: {
          ...follow,
          stop:
            input.status === "cancelled"
              ? null
              : { ...stop, refusedTurnId: input.turnId, inFlightTurnId: null },
        },
        cancel: null,
      };
    }
  }
}

/** Apply one input, then settle or land a waiting Stop. */
export function stepRunFollow(follow: RunFollow, input: RunFollowInput): RunFollowStep {
  const applied = apply(follow, input);
  let next = applied.follow;
  const owed = owedOf(next);
  if ([...owed].some((id) => !next.tracked.has(id)))
    next = { ...next, tracked: new Set([...next.tracked, ...owed]) };
  // Kept after delivery: the execution that served a later message stays protected.
  const pressed = next.stop;
  if (pressed) {
    const later = [...owed].filter(
      (id) => !pressed.owedAtPress.has(id) && !pressed.owedAfterPress.has(id),
    );
    if (later.length > 0)
      next = {
        ...next,
        stop: { ...pressed, owedAfterPress: new Set([...pressed.owedAfterPress, ...later]) },
      };
  }
  const view = viewRunFollow(next);
  if (view.settled) {
    const reset =
      next.tracked.size > 0 || next.attached || next.steer || next.stop
        ? { ...next, tracked: NONE, attached: null, steer: null, stop: null }
        : next;
    return { follow: reset, cancel: null };
  }
  if (applied.cancel !== null) return { follow: next, cancel: applied.cancel };
  const { stop } = next;
  const target = view.target;
  if (!stop || stop.inFlightTurnId !== null || target === null || target === stop.refusedTurnId)
    return { follow: next, cancel: null };
  const executionId = next.facts.turns.get(target)?.executionId;
  if (
    !executionId ||
    !executionsServing(next.facts, stop.owedAtPress).has(executionId) ||
    executionsServing(next.facts, stop.owedAfterPress).has(executionId)
  )
    return { follow: next, cancel: null };
  return { follow: { ...next, stop: { ...stop, inFlightTurnId: target } }, cancel: target };
}
