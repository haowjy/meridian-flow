/**
 * Request-ID wire grammar for values backed by Postgres `uuid` columns.
 *
 * The wire accepts exactly the canonical 36-character, hyphenated hexadecimal
 * UUID shape, case-insensitively, and normalizes it to lowercase. UUID
 * version and variant bits are data, not syntax. Alternate Postgres spellings
 * such as braces, omitted hyphens, and `urn:uuid:` are deliberately rejected.
 *
 * This lives in contracts because both sides of the wire parse it: the server
 * at its transport boundaries, and the client wherever it reads an ID out of a
 * URI. One grammar, one home.
 */

const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare const parsedRequestId: unique symbol;
export type ParsedRequestId = string & { readonly [parsedRequestId]: true };

export function parseRequestId(value: unknown): ParsedRequestId | null {
  if (typeof value !== "string" || !REQUEST_ID_RE.test(value)) return null;
  return value.toLowerCase() as ParsedRequestId;
}

/** Defensive predicate for repository and persistence boundaries. */
export function isUuid(value: string): value is ParsedRequestId {
  return parseRequestId(value) !== null;
}
