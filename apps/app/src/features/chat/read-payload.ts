/**
 * Reads a `read` call's typed result (`ToolView.result`) for chat rendering.
 * The model's text rendering of the same result is never parsed here.
 */
import type { JsonValue } from "@meridian/contracts/protocol";

export type OutlineHeading = { level: number; text: string };

const HEADING_LINE = /^(#{1,6})\s+(.*)$/;

/** The agent-edit result schema; its block items already carry hash-free bodies. */
const READ_RESULT_SCHEMA = "meridian.agent-edit.v1";

/** How a read of a file that isn't a tracked document went: what the model was given of it. */
export type ReadFile = {
  documentId: string;
  name: string;
  given: "media" | "text" | "description";
};

export function readPayloadFile(result: JsonValue | null | undefined): ReadFile | null {
  if (!isRecord(result) || result.schema !== READ_RESULT_SCHEMA) return null;
  const file = result.file;
  if (
    !isRecord(file) ||
    typeof file.documentId !== "string" ||
    typeof file.name !== "string" ||
    (file.given !== "media" && file.given !== "text" && file.given !== "description")
  )
    return null;
  return { documentId: file.documentId, name: file.name, given: file.given };
}

/** The document body the read returned, with no block hashes; each block its own paragraph. */
export function readPayloadMarkup(result: JsonValue | null | undefined): string {
  const bodies = documentBodies(result);
  return bodies === null ? "" : bodies.join("\n\n").trim();
}

export function readPayloadOutline(result: JsonValue | null | undefined): OutlineHeading[] | null {
  const bodies = documentBodies(result);
  if (bodies === null) return null;
  const headings: OutlineHeading[] = [];
  for (const line of bodies.flatMap((body) => body.split("\n"))) {
    const match = HEADING_LINE.exec(line.trim());
    if (!match) continue;
    headings.push({ level: match[1].length, text: match[2].trim() });
  }
  if (headings.length === 0) return null;
  return normalizeDepth(headings);
}

/**
 * The `body` of every block the read returned as the document. `null` when
 * the value isn't an agent-edit result, as on rows that predate `result`.
 */
function documentBodies(result: JsonValue | null | undefined): string[] | null {
  if (!isRecord(result) || result.schema !== READ_RESULT_SCHEMA) return null;
  const groups = result.blocks;
  if (!Array.isArray(groups)) return null;
  const bodies: string[] = [];
  for (const group of groups) {
    if (!isRecord(group) || group.relation !== "document" || !Array.isArray(group.items)) continue;
    for (const item of group.items) {
      if (isRecord(item) && typeof item.body === "string") bodies.push(item.body);
    }
  }
  return bodies;
}

function isRecord(value: JsonValue | null | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Indent relative to the shallowest heading present. A chapter read that starts
 * at `##` should not open with every line already pushed in.
 */
function normalizeDepth(headings: OutlineHeading[]): OutlineHeading[] {
  const shallowest = Math.min(...headings.map((heading) => heading.level));
  return headings.map((heading) => ({ ...heading, level: heading.level - shallowest }));
}
