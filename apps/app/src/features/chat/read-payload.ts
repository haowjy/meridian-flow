import { splitHashline } from "@meridian/agent-edit";
import type { JsonValue } from "@meridian/contracts/protocol";

/** Normalizes document-reading tool payloads for chat rendering. */
export type OutlineHeading = { level: number; text: string };

/**
 * The locator an outline read prints under each heading so the model can read
 * that section next. Machinery, never shown.
 */
const LOCATOR_LINE = /^write\(command="read"/;

const HEADING_LINE = /^(#{1,6})\s+(.*)$/;

/** The read command's result schema; its block items already carry hash-free bodies. */
const READ_ENVELOPE_SCHEMA = "meridian.agent-edit.v1";

/** The document body, with every block hash removed. */
export function readPayloadMarkup(output: JsonValue | null | undefined): string {
  const lines = readPayloadLines(output);
  return lines === null ? "" : lines.join("\n").trim();
}

export function readPayloadOutline(output: JsonValue | null | undefined): OutlineHeading[] | null {
  const lines = readPayloadLines(output);
  if (lines === null) return null;
  const headings: OutlineHeading[] = [];
  for (const line of lines) {
    const body = line.trim();
    if (!body || LOCATOR_LINE.test(body)) continue;
    const match = HEADING_LINE.exec(body);
    if (!match) continue;
    headings.push({ level: match[1].length, text: match[2].trim() });
  }
  if (headings.length === 0) return null;
  return normalizeDepth(headings);
}

/**
 * The payload's lines with their addressing stripped, whichever shape it
 * arrived in. `null` when it carries no document content at all.
 */
function readPayloadLines(output: JsonValue | null | undefined): string[] | null {
  if (typeof output === "string") return output.split("\n").map(blockBody);
  const bodies = envelopeBodies(output);
  return bodies === null ? null : bodies.flatMap((body) => body.split("\n"));
}

function blockBody(line: string): string {
  return splitHashline(line)?.body ?? line;
}

/** The `body` of every block item in a `meridian.agent-edit.v1` read envelope. */
function envelopeBodies(output: JsonValue | null | undefined): string[] | null {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return null;
  if (output.schema !== READ_ENVELOPE_SCHEMA) return null;
  const blocks = output.blocks;
  if (!Array.isArray(blocks)) return null;
  const bodies: string[] = [];
  for (const group of blocks) {
    if (group === null || typeof group !== "object" || Array.isArray(group)) continue;
    const items = group.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const body = item.body;
      if (typeof body === "string") bodies.push(body);
    }
  }
  return bodies;
}

/**
 * Indent relative to the shallowest heading present. A chapter read that starts
 * at `##` should not open with every line already pushed in.
 */
function normalizeDepth(headings: OutlineHeading[]): OutlineHeading[] {
  const shallowest = Math.min(...headings.map((heading) => heading.level));
  return headings.map((heading) => ({ ...heading, level: heading.level - shallowest }));
}
