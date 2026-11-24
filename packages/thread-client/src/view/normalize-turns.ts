import type { Turn } from "@meridian/contracts/protocol";
import { inConversation, retryTargetOf } from "@meridian/contracts/threads";
import { placeStandIns } from "./retry-stand-ins";

export type TurnFacts = {
  turns: Turn[];
  opening?: Turn | null;
  standIns?: readonly Turn[];
  hidden?: ReadonlySet<string>;
  retried?: ReadonlySet<string>;
};

export type NormalizedTurns = {
  facts: TurnFacts;
  placed: Turn[];
  turns: Turn[];
};

export function normalizeTurns(facts: TurnFacts): NormalizedTurns {
  const placed = placeStandIns(
    facts.opening ? [facts.opening, ...facts.turns] : facts.turns,
    facts.standIns ?? [],
  );
  const retried = new Set(facts.retried);
  for (const turn of placed) {
    const target = retryTargetOf(turn);
    if (target !== null) retried.add(target);
  }
  const turns = placed.filter(
    (turn) => !facts.hidden?.has(turn.id) && !retried.has(turn.id) && inConversation(turn),
  );
  return { facts, placed, turns };
}
