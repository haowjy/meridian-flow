/**
 * normalize-turns — the effective local sequence every later chat projection reads: Retry stand-ins
 * placed, a Retry (stored, stand-in, or explicitly pending) suppressing the failed reply it retries,
 * an optimistic hand-back hiding its writer turns, and a forgotten turn left out. `latestRow`,
 * `chatCards` and `viewTranscript` consume its output; none re-derives it. The turns stay in the
 * store: this is drawing only.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { inConversation, retryTargetOf } from "@meridian/contracts/threads";
import { placeStandIns } from "./retry-stand-ins";

export type TurnFacts = {
  /** Stored turns in order, local writer turns included. */
  turns: Turn[];
  /**
   * The seed card of a handoff whose destination the server hasn't created yet. It leads the
   * sequence, ahead of stand-in placement.
   */
  opening?: Turn | null;
  /** Local placeholders for turns the server doesn't have yet, laid over `turns` by `prevTurnId`. */
  standIns?: readonly Turn[];
  /** Writer turns a hand-back request in flight hides (`hiddenWriterTurns`). */
  hidden?: ReadonlySet<string>;
  /**
   * Failed replies whose accepted Retry the stored turns do not show yet: the Retry's target,
   * carried explicitly. A Retry the turns do show says so itself (`metadata.retryOf`).
   */
  retried?: ReadonlySet<string>;
};

export type NormalizedTurns = {
  facts: TurnFacts;
  /** Stand-ins placed, nothing suppressed: the turns a card may still anchor on. */
  placed: Turn[];
  /** The conversation the writer is in: `placed` less the hidden, the retried and the forgotten. */
  turns: Turn[];
  /** Failed replies a Retry replaces, explicit or named by a placed turn's `metadata.retryOf`. */
  retried: ReadonlySet<string>;
};

export function normalizeTurns(facts: TurnFacts): NormalizedTurns {
  const placed = placeStandIns(
    facts.opening ? [facts.opening, ...facts.turns] : facts.turns,
    facts.standIns ?? [],
  );
  // A chain of failed retries draws only the newest: every placed Retry names its target.
  const retried = new Set(facts.retried);
  for (const turn of placed) {
    const target = retryTargetOf(turn);
    if (target !== null) retried.add(target);
  }
  const turns = placed.filter(
    (turn) => !facts.hidden?.has(turn.id) && !retried.has(turn.id) && inConversation(turn),
  );
  return { facts, placed, turns, retried };
}
