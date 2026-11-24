/**
 * What a commit's message says (design §5): who wrote it, for attribution, and whether it was
 * written in a draft. Every commit message is written by `commitMessage` and read by
 * `readCommitMessage`.
 */

/** Who wrote a commit: a chat's turn, or a press. A commit with no author is the writer's own. */
export type CommitAuthor = { turn: string } | { press: string };

/**
 * The message a commit by `by` is committed under; none for the writer's own. `draft` marks a
 * commit made in a draft's fork, so a copy that later imports it into Live through an Apply can
 * tell it from a write made in Live (`RoomDocs.importBatch`'s `authors`).
 */
export function commitMessage(by: CommitAuthor | undefined, draft: boolean): string | undefined {
  if (!by) return undefined;
  return JSON.stringify(draft ? { by, draft: true } : { by });
}

/** What a commit's message says. Messages come from any peer: what is not well formed says nothing. */
export function readCommitMessage(message: string | undefined): {
  by?: CommitAuthor;
  draft: boolean;
} {
  if (!message?.startsWith("{")) return { draft: false };
  let said: unknown;
  try {
    said = JSON.parse(message);
  } catch {
    return { draft: false };
  }
  if (typeof said !== "object" || said === null) return { draft: false };
  const { by, draft } = said as { by?: unknown; draft?: unknown };
  const where = { draft: draft === true };
  if (typeof by !== "object" || by === null) return where;
  const { turn, press } = by as { turn?: unknown; press?: unknown };
  if (typeof turn === "string") return { by: { turn }, ...where };
  if (typeof press === "string") return { by: { press }, ...where };
  return where;
}
