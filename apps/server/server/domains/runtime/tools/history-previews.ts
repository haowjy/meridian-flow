/** Compact navigation markers, never document text or drafted edit inputs. */
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
export function readHistoryPreview(input: JsonObject): string {
  return String(input.path ?? "");
}
export function writeHistoryPreview(input: JsonObject): string {
  const size =
    typeof input.content === "string"
      ? `, ${input.content.trim().split(/\s+/u).filter(Boolean).length.toLocaleString("en-US")} words`
      : "";
  return `${input.command ?? ""} ${input.path ?? ""}${size}`;
}
export function spawnHistoryPreview(input: JsonObject, output?: JsonValue): string {
  const result = output as JsonObject | undefined;
  return `→ ${result?.handle ?? (result?.report as JsonObject | undefined)?.handle ?? ""} ${JSON.stringify(input.description ?? "")}`;
}
export function threadHistoryPreview(input: JsonObject, output?: JsonValue): string {
  const outputRef =
    typeof output === "string"
      ? /^Conversation ([cp]\d+)\b/u.exec(output)?.[1]
      : typeof (output as JsonObject | undefined)?.ref === "string"
        ? String((output as JsonObject).ref)
        : undefined;
  if (input.ref !== undefined && input.ref !== "current") return String(input.ref);
  return outputRef ?? String(input.ref ?? "current");
}

export function threadLsHistoryPreview(input: JsonObject, output?: JsonValue): string {
  if (input.ref !== undefined && input.ref !== "current") return String(input.ref);
  const targetRef =
    typeof output === "string"
      ? output
          .split("\n")
          .find((line) => !line.includes(" › "))
          ?.match(/^([cp]\d+)\b/u)?.[1]
      : undefined;
  return targetRef ?? String(input.ref ?? "current");
}
