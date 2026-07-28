/**
 * hashline — the `hash|body` serialization the agent reads and addresses blocks
 * by. Every read and write of that format goes through here.
 *
 * The prefix exists for the model: it is how a write command names the block it
 * means. It is not writer-facing vocabulary, so any surface that shows a line to
 * a human strips it first.
 *
 * Two readers, because callers arrive with two different certainties:
 *
 * - {@link splitHashline} for a line this system serialized. It is the exact
 *   inverse of {@link toHashline}, including the empty hash `serializeBlocks`
 *   can emit, and it splits at the first `|` because that is where the writer
 *   put it.
 * - {@link stripBlockHash} for a line that may never have been serialized at
 *   all. It only removes a prefix shaped like a real hash, because a blind
 *   split would eat the leading cell of a markdown table row.
 *
 * Reach for the second only when the input is genuinely mixed. `search` excerpts
 * are the case that exists: they come back as hashlines for manuscript
 * documents and as raw markdown for every other scheme.
 */
import { DEFAULT_HASH_LENGTH, fullHashForItemId } from "./block-hash.js";

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

/**
 * Longest a display hash can be: {@link fullHashForItemId} concatenates a
 * 64-bit FNV digest with two fixed-width hex fields, and a display hash is a
 * prefix of that.
 */
const MAX_HASH_LENGTH = fullHashForItemId({ clientID: 0, clock: 0 }).length;

/**
 * Anchored because a hash only ever leads a line, and length-bounded to the
 * real hash range so prose and table rows survive intact.
 */
const HASH_PREFIX = new RegExp(`^[0-9a-f]{${DEFAULT_HASH_LENGTH},${MAX_HASH_LENGTH}}\\|`);

/** The writer-facing body of a line that may or may not carry a block hash. */
export function stripBlockHash(line: string): string {
  return line.replace(HASH_PREFIX, "");
}
