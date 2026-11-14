/** What the list says about one document's removal, in the shape the notices and banners read. */
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { DocumentStanding } from "@/core/tree-list/standing";

/** `removed`: in Trash, purged or not in the list. `record` names who deleted it, when the list says. */
export type RemovalAnswer =
  | { kind: "removed"; record: DocumentRemovalRecord | null }
  | { kind: "available" };

/**
 * The removing record's actor (`user:<id>`, `agent:<chat>/<turn>`) as the notice's sentence reads
 * it. A Discard is said as one even when the list doesn't name who made it.
 */
export function removalRecordOf(
  actor: string | null,
  reason: DocumentRemovalRecord["reason"] = "deleted",
): DocumentRemovalRecord | null {
  if (actor?.startsWith("user:"))
    return {
      reason,
      actor: { kind: "user", userId: actor.slice(5) as never, displayName: null },
      time: "",
    };
  if (actor?.startsWith("agent:"))
    return { reason, actor: { kind: "agent", chatTitle: null }, time: "" };
  return reason === "discarded" ? { reason, actor: null, time: "" } : null;
}

const AVAILABLE: RemovalAnswer = { kind: "available" };
const known = new WeakMap<DocumentStanding, RemovalAnswer>();

/**
 * Undefined while the list has not been read: nothing is known, so nothing is shown. The same
 * standing gives the same answer object, so a React snapshot is stable while nothing changed.
 */
export function removalAnswer(standing: DocumentStanding): RemovalAnswer | undefined {
  if (standing.kind === "waiting") return undefined;
  let answer = known.get(standing);
  if (!answer) {
    answer = answerOf(standing);
    known.set(standing, answer);
  }
  return answer;
}

function answerOf(standing: DocumentStanding): RemovalAnswer {
  switch (standing.kind) {
    case "waiting":
      throw new Error("A list not yet read has no answer");
    case "in-tree":
      return AVAILABLE;
    case "in-trash":
      return { kind: "removed", record: removalRecordOf(standing.deletedBy) };
    case "purged":
    case "not-in-list":
      if (standing.discardedBy !== undefined)
        return { kind: "removed", record: removalRecordOf(standing.discardedBy, "discarded") };
      return { kind: "removed", record: null };
  }
}
