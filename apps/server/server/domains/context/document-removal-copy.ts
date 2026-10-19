/**
 * Model- and receipt-facing words for a removed document, from its removal record
 * (e2 D9). One phrase serves every reader, so a save receipt, a known-id denial and a
 * turn inverse's skip name the same fact.
 */
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";

const SYSTEM_CAUSE = {
  reply_rolled_back: "removed when the reply that created it didn't finish",
  create_failed: "removed when the reply that created it didn't finish",
  repair: "removed by repair",
} as const;

/**
 * "deleted by Ana", "discarded from the draft by Ana", "removed by repair". Without a record
 * the file was removed and the reader cannot say how: a closed draft over a document that
 * stands again, or a legacy removal.
 */
export function removalPhrase(removal: DocumentRemovalRecord | null | undefined): string {
  if (!removal) return "deleted";
  const { actor } = removal;
  if (actor?.kind === "system") return SYSTEM_CAUSE[actor.cause];
  const verb = removal.reason === "deleted" ? "deleted" : "discarded from the draft";
  const name = actor?.kind === "work" ? actor.name : actor?.displayName;
  return name ? `${verb} by ${name}` : verb;
}
