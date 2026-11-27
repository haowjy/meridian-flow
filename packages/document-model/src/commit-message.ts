/**
 * What a commit's message says (design §5): who wrote it, for attribution. Every commit message is
 * written by `commitMessage` and read by `readCommitMessage`.
 */

export type CommitAuthor = { turn: string } | { press: string };

/** The message a commit by `by` is committed under; none for the writer's own. */
export function commitMessage(by: CommitAuthor | undefined): string | undefined {
  return by ? JSON.stringify({ by }) : undefined;
}

/** Who a commit's message says wrote it. Messages come from any peer: what is not well formed says nothing. */
export function readCommitMessage(message: string | undefined): { by?: CommitAuthor } {
  if (!message?.startsWith("{")) return {};
  let said: unknown;
  try {
    said = JSON.parse(message);
  } catch {
    return {};
  }
  if (typeof said !== "object" || said === null) return {};
  const { by } = said as { by?: unknown };
  if (typeof by !== "object" || by === null) return {};
  const { turn, press } = by as { turn?: unknown; press?: unknown };
  if (typeof turn === "string") return { by: { turn } };
  if (typeof press === "string") return { by: { press } };
  return {};
}
