/** Serialize a report payload for both display and clipboard output. */
import type { JsonValue } from "@meridian/contracts/protocol";

export function payloadText(payload: JsonValue | undefined): string {
  if (payload === undefined) return "";
  return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}
