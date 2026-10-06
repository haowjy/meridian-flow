// The bounded receipt of a copy: never the copied text, so a copied chapter
// doesn't come back into the model's context (D23, D24).
import type { BlockSnapshot } from "../apply/echo.js";
import { truncateSerializedBlock } from "../apply/echo.js";
import { splitHashline, toHashline } from "../model/hashline.js";

/** What a copy wrote, kept with the staged write so its settled receipt says the same. */
export interface CopySummary {
  /** The source path as the model named it. */
  from: string;
  /** How many blocks the copy wrote. */
  blocks: number;
  /** The first and last new block (one when they're the same); empty for a document copy. */
  edgeHashes: readonly string[];
}

const PREFIX_MAX_CHARACTERS = 60;

/**
 * A block copy names its first and last new block; a document copy names
 * none, since its blocks are the document.
 */
export function copySummary(
  from: string,
  insertedHashes: readonly string[],
  options: { edges: boolean },
): CopySummary {
  const first = insertedHashes[0];
  const last = insertedHashes.at(-1);
  const edgeHashes =
    !options.edges || first === undefined || last === undefined
      ? []
      : first === last
        ? [first]
        : [first, last];
  return { from, blocks: insertedHashes.length, edgeHashes };
}

/** The edge blocks as `hash|prefix` lines, read from the document as it is now. */
export function copyEdgeLines(
  summary: CopySummary,
  snapshot: readonly Pick<BlockSnapshot, "hash" | "serialized">[],
): string[] {
  const byHash = new Map(snapshot.map((block) => [block.hash, block.serialized]));
  return summary.edgeHashes.flatMap((hash) => {
    const serialized = byHash.get(hash);
    return serialized === undefined ? [] : [boundedPrefix(serialized)];
  });
}

/** A few words, and never more than a short line, so text without spaces stays bounded too. */
function boundedPrefix(serialized: string): string {
  const line = splitHashline(truncateSerializedBlock(serialized));
  if (!line) return serialized.slice(0, PREFIX_MAX_CHARACTERS);
  const body = line.body.replace(/^\n/, "");
  const firstLine = body.split("\n")[0] ?? "";
  return toHashline(line.hash, firstLine.slice(0, PREFIX_MAX_CHARACTERS));
}
