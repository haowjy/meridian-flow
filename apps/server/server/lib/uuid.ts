/**
 * UUID shape guard for id-typed route params before they reach a `uuid` column.
 *
 * Postgres `uuid` columns reject any non-UUID text with a `22P02` parse error
 * that surfaces as an unhandled 500. Repository `findById` boundaries call this
 * so a malformed id (e.g. a project slug in a `:projectId` route) resolves to a
 * clean not-found instead of leaking a driver error.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
