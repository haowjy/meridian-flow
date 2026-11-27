/**
 * hashline — the `hash|body` serialization the agent reads and addresses blocks
 * by. Every read and write of that format goes through here.
 *
 * The prefix exists for the model: it is how a write command names the block it
 * means. It is not writer-facing vocabulary, so any surface that shows a line to
 * a human strips it first.
 *
 * {@link splitHashline} is the exact inverse of {@link toHashline}, including
 * an empty hash. It splits at the first `|` because
 * that is where the writer put it.
 */

export interface Hashline {
  hash: string;
  body: string;
}

export function toHashline(hash: string, body: string): string {
  return body.includes("\n") ? `${hash}|\n${body}` : `${hash}|${body}`;
}

export function splitHashline(serialized: string): Hashline | null {
  const separator = serialized.indexOf("|");
  if (separator < 0) return null;
  return { hash: serialized.slice(0, separator), body: serialized.slice(separator + 1) };
}
