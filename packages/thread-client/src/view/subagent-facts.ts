/** Cached durable subagent facts shared by transcript and activity projections. */
import { parseInvocationCard } from "@meridian/contracts/components";
import type { Block, Turn } from "@meridian/contracts/protocol";
import { parseSubagentUpdateMetadata } from "@meridian/contracts/spawn";
import { sameJson } from "../turns/same-turn";

/** A persisted record that missed its contract. The caller decides where this is reported. */
export type PersistedContractFailure = {
  contract: "invocation_card" | "subagent_update";
  threadId?: string;
  turnId?: string;
  blockId?: string;
};

export type InvocationFact = {
  block: Block;
  card: NonNullable<ReturnType<typeof parseInvocationCard>>;
};

export type CompletionFact = {
  update: NonNullable<ReturnType<typeof parseSubagentUpdateMetadata>>;
  completedAt: Turn["completedAt"];
  turnId: string;
  threadId: string;
};

export type TurnSubagentFacts = {
  invocations: readonly InvocationFact[];
  completion: CompletionFact | null;
  failures: readonly PersistedContractFailure[];
};

const EMPTY_FACTS: TurnSubagentFacts = Object.freeze({
  invocations: Object.freeze([]),
  completion: null,
  failures: Object.freeze([]),
});
const cache = new WeakMap<Turn, TurnSubagentFacts>();

export function turnSubagentFacts(turn: Turn): TurnSubagentFacts {
  const cached = cache.get(turn);
  if (cached) return cached;
  const invocations: InvocationFact[] = [];
  const failures: PersistedContractFailure[] = [];
  const metadata =
    turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
      ? (turn.metadata as Record<string, unknown>)
      : null;
  let completion: CompletionFact | null = null;
  if (metadata?.kind === "subagent_update") {
    const update = parseSubagentUpdateMetadata(metadata);
    if (update) {
      completion = {
        update,
        completedAt: turn.completedAt,
        turnId: turn.id,
        threadId: turn.threadId,
      };
    } else {
      failures.push({ contract: "subagent_update", turnId: turn.id });
    }
  }
  for (const block of turn.blocks) {
    const content =
      block.content && typeof block.content === "object" && !Array.isArray(block.content)
        ? (block.content as Record<string, unknown>)
        : null;
    if (content?.kind !== "helper-result") continue;
    const card = parseInvocationCard(block.content);
    if (card) invocations.push({ block, card });
    else failures.push({ contract: "invocation_card", turnId: turn.id, blockId: block.id });
  }
  const facts =
    invocations.length || completion || failures.length
      ? { invocations, completion, failures }
      : EMPTY_FACTS;
  cache.set(turn, facts);
  return facts;
}

export function sameSubagentFacts(left: TurnSubagentFacts, right: TurnSubagentFacts): boolean {
  const fields = {
    invocations: "invocations",
    completion: "completion",
    failures: "json",
  } satisfies Record<keyof TurnSubagentFacts, "invocations" | "completion" | "json">;
  void fields;
  return (
    left.invocations.length === right.invocations.length &&
    left.invocations.every((fact, index) => fact.block === right.invocations[index]?.block) &&
    sameJson(left.completion, right.completion) &&
    sameJson(left.failures, right.failures)
  );
}
