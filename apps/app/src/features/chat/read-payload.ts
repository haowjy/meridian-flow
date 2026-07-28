/**
 * read-payload — turns what `write(command="read")` returned into what the
 * writer sees.
 *
 * The payload is the model's view of a document: one hashline per block, or,
 * for an outline read, headings interleaved with the locator lines the model
 * uses to read further. Both are addressing machinery. Neither is prose the
 * writer wrote, so both are stripped here rather than in a renderer.
 *
 * This payload is serialized by this system, so it reads through
 * {@link splitHashline} rather than the anchored stripper: a block whose hash
 * came through empty serializes as `|body`, and an anchored prefix match
 * correctly refuses to touch that, which would leak a leading pipe into the
 * writer's prose and lose an empty-hash heading entirely. The anchored
 * stripper belongs at genuinely mixed seams, like `search` excerpts, which come
 * back as raw markdown for every scheme with no hashline shadow.
 *
 * Targeting is resolved server-side, so the payload already *is* the region the
 * model asked for. That makes the preview rule the same for a bare read and a
 * scoped one: show the top of what came back. No location prediction, no
 * per-command branching.
 */
import { splitHashline } from "@meridian/agent-edit";

/** A heading an outline read reported, with the depth it sat at. */
export type OutlineHeading = { level: number; text: string };

/**
 * The locator an outline read prints under each heading so the model can read
 * that section next. Machinery, never shown.
 */
const LOCATOR_LINE = /^write\(command="read"/;

const HEADING_LINE = /^(#{1,6})\s+(.*)$/;

/** The document body, with every block hash removed. */
export function readPayloadMarkup(output: string): string {
  return output.split("\n").map(blockBody).join("\n").trim();
}

function blockBody(line: string): string {
  return splitHashline(line)?.body ?? line;
}

/**
 * The headings an outline read saw, or `null` when the payload carries none.
 *
 * A `null` here is not a failure: `renderOutline` falls back to whole blocks
 * for a document with no headings, so the caller renders that payload as the
 * prose it is.
 */
export function readPayloadOutline(output: string): OutlineHeading[] | null {
  const headings: OutlineHeading[] = [];
  for (const line of output.split("\n")) {
    const body = blockBody(line).trim();
    if (!body || LOCATOR_LINE.test(body)) continue;
    const match = HEADING_LINE.exec(body);
    if (!match) continue;
    headings.push({ level: match[1].length, text: match[2].trim() });
  }
  if (headings.length === 0) return null;
  return normalizeDepth(headings);
}

/**
 * Indent relative to the shallowest heading present. A chapter read that starts
 * at `##` should not open with every line already pushed in.
 */
function normalizeDepth(headings: OutlineHeading[]): OutlineHeading[] {
  const shallowest = Math.min(...headings.map((heading) => heading.level));
  return headings.map((heading) => ({ ...heading, level: heading.level - shallowest }));
}
