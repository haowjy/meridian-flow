/** Connect-time compatibility check between a client bundle and a persisted Yjs head. */

export function isClientSchemaSuperseded(
  clientSchemaVersion: number,
  headSchemaVersion: number | null,
): boolean {
  return headSchemaVersion !== null && clientSchemaVersion < headSchemaVersion;
}
