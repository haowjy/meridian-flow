/**
 * read-payload — turns what `write(command="read")` returned into what the
 * writer sees.
 *
 * Two shapes carry the model's view of a document. The read command returns the
 * `meridian.agent-edit.v1` envelope, whose block items already separate `hash`
 * from `body`, so those bodies are the document as the model received it. Any
 * remaining caller hands back the serialized form: one hashline per block, or,
 * for an outline read, headings interleaved with the locator lines the model
 * uses to read further. Both are addressing machinery, so it is stripped here
 * rather than in a renderer, and both public readers accept either shape so no
 * renderer branches on the payload.
 *
 * The serialized path reads through {@link splitHashline} rather than the
 * anchored stripper: a block whose hash came through empty serializes as
 * `|body`, and an anchored prefix match correctly refuses to touch that, which
 * would leak a leading pipe into the writer's prose and lose an empty-hash
 * heading entirely. Envelope bodies are already hash-free, so they are taken
 * verbatim and a legitimate `|` in the writer's prose survives.
 *
 * Targeting is resolved server-side, so the payload already *is* the region the
 * model asked for. That makes the preview rule the same for a bare read and a
 * scoped one: show the top of what came back. No location prediction, no
 * per-command branching.
 */
import { splitHashline } from "@meridian/agent-edit";
import type { JsonValue } from "@meridian/contracts/protocol";

/** A heading an outline read reported, with the depth it sat at. */
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

/**
 * The headings an outline read saw, or `null` when the payload carries none.
 *
 * A `null` here is not a failure: `renderOutline` falls back to whole blocks
 * for a document with no headings, so the caller renders that payload as the
 * prose it is.
 */
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
