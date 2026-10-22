// The model's words for a removed document, from its removal record. One phrase serves every
// reader, so a call that names the file, a staged write the removal refused, a reply's save and
// an undo that reached it all say the same fact. Writer-facing copy is the app's own.
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";

/**
 * "deleted by Ana", "discarded from the draft by Ana", "removed by repair". Without a record the
 * file is gone but not removed itself: its source or Work went, or a closed draft sits over a
 * document that stands again.
 */
export function removalPhrase(removal: DocumentRemovalRecord | null | undefined): string {
  if (!removal) return "deleted";
  const { actor } = removal;
  if (actor?.kind === "system")
    return actor.cause === "repair"
      ? "removed by repair"
      : "removed when the reply that created it didn't finish";
  const verb = removal.reason === "deleted" ? "deleted" : "discarded from the draft";
  const name = actor?.kind === "work" ? actor.name : actor?.displayName;
  return name ? `${verb} by ${name}` : verb;
}

/**
 * A read through a draft that outlived its document's live delete (D79): the draft is ordinary
 * and writable, and only the writer's Apply brings the document back to the manuscript.
 */
export function survivingDraftNotice(removal: DocumentRemovalRecord | null | undefined): string {
  const actor = removal?.actor;
  const name =
    actor?.kind === "work" ? actor.name : actor?.kind === "user" ? actor.displayName : null;
  return `Deleted from the manuscript${name ? ` by ${name}` : ""}. Your draft still has it; Apply brings it back.`;
}

/** A call that named a removed file: `document_not_found`, "File not found. This file was deleted by Ana." */
export function removedFile(removal: DocumentRemovalRecord | null | undefined): {
  status: "document_not_found";
  message: string;
} {
  return {
    status: "document_not_found",
    message: `File not found. This file was ${removalPhrase(removal)}.`,
  };
}

/**
 * A write the removal stopped before the reply saved it. A system removal is the reply's own, so
 * it never says "before this reply was saved".
 */
export function removedWriteMessage(removal: DocumentRemovalRecord | null | undefined): string {
  const removed = `This file was ${removalPhrase(removal)}`;
  return removal?.actor?.kind !== "system"
    ? `${removed} before this reply was saved, so this change wasn't made.`
    : `${removed}, so this change wasn't made.`;
}
