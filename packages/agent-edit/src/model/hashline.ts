/**
 * hashline — the `hash|body` serialization the agent reads and addresses blocks
 * by. Every read and write of that format goes through here.
 *
 * The prefix exists for the model: it is how a write command names the block it
 * means. It is not writer-facing vocabulary, so any surface that shows a line to
 * a human strips it first.
 *
 * {@link splitHashline} is the exact inverse of {@link toHashline}, including
 * the empty hash `serializeBlocks` can emit. It splits at the first `|` because
 * that is where the writer put it.
 */

/** The two halves of a serialized block. */
export interface Hashline {
  /** Empty when the writer had no hash for the block. */
  hash: string;
  body: string;
}

/**
 * Serialize one block for the agent. A multi-line body starts on its own line
 * so the prefix never runs into prose.
 */
export function toHashline(hash: string, body: string): string {
  return body.includes("\n") ? `${hash}|\n${body}` : `${hash}|${body}`;
}

/**
 * Split a line this system serialized. `null` when the line carries no
 * separator at all, which means it is not a hashline and the caller decides
 * what the whole string is — historically a body in some places and a hash in
 * others, and only the caller knows which.
 */
export function splitHashline(serialized: string): Hashline | null {
  const separator = serialized.indexOf("|");
  if (separator < 0) return null;
  return { hash: serialized.slice(0, separator), body: serialized.slice(separator + 1) };
}
