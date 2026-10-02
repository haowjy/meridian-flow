/** Compact navigation markers, never document text or drafted edit inputs. */
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
export function readHistoryPreview(input: JsonObject): string {
  return String(input.path ?? "");
}
export function writeHistoryPreview(input: JsonObject, result?: JsonValue): string {
  const size =
    typeof input.content === "string"
      ? `, ${input.content.trim().split(/\s+/u).filter(Boolean).length.toLocaleString("en-US")} words`
      : "";
  const write = (result as JsonObject | undefined)?.write as JsonObject | undefined;
  const handle = typeof write?.id === "string" ? `, ${write.id}` : "";
  return `${input.command ?? ""} ${input.path ?? ""}${size}${handle}`;
}
export function spawnHistoryPreview(input: JsonObject, result?: JsonValue): string {
  const output = result as JsonObject | undefined;
  const handle = output?.handle ?? (output?.report as JsonObject | undefined)?.handle;
  return `${JSON.stringify(input.name ?? "")}${typeof handle === "string" ? ` → ${handle}` : ""}`;
}
export function workHistoryPreview(input: JsonObject): string {
  const target = input.work ?? input.target ?? input.name;
  return `${input.command ?? ""}${typeof target === "string" ? ` ${target}` : ""}`;
}
/** The conversation a thread tool resolved, from its typed result (`ref`), never its text. */
function resolvedRef(input: JsonObject, result?: JsonValue): string {
  if (input.ref !== undefined && input.ref !== "current") return String(input.ref);
  const ref = (result as JsonObject | null | undefined)?.ref;
  return typeof ref === "string" ? ref : String(input.ref ?? "current");
}
export function threadHistoryPreview(input: JsonObject, result?: JsonValue): string {
  return resolvedRef(input, result);
}
export function threadLsHistoryPreview(input: JsonObject, result?: JsonValue): string {
  return resolvedRef(input, result);
}
