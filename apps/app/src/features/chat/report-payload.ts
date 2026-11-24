import type { JsonValue } from "@meridian/contracts/protocol";

export function payloadText(payload: JsonValue | undefined): string {
  if (payload === undefined) return "";
  return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}
