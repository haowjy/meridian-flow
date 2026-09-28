/** Compact navigation markers, never document text or drafted edit inputs. */
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
export function writeHistoryPreview(input: JsonObject): string {
  const size =
    typeof input.content === "string"
      ? `, ${input.content.trim().split(/\s+/u).filter(Boolean).length.toLocaleString("en-US")} words`
      : "";
  return `${input.command ?? ""} ${input.path ?? input.document_id ?? ""}${size}`;
}
export function spawnHistoryPreview(input: JsonObject, output?: JsonValue): string {
  const result = output as JsonObject | undefined;
  return `→ ${result?.handle ?? (result?.report as JsonObject | undefined)?.handle ?? ""} ${JSON.stringify(input.description ?? "")}`;
}
export function threadHistoryPreview(input: JsonObject, output?: JsonValue): string {
  const run = input.run ?? (output as JsonObject | undefined)?.run;
  return `${input.ref ?? "current"}${run ? ` run ${run}` : ""}`;
}
