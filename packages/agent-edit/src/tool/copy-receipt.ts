import type { BlockSnapshot } from "../apply/echo.js";
import { truncateSerializedBlock } from "../apply/echo.js";
import { splitHashline, toHashline } from "../model/hashline.js";

export interface CopySummary {
  from: string;
  blocks: number;
  edgeHashes: readonly string[];
}

const PREFIX_MAX_CHARACTERS = 60;

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

function boundedPrefix(serialized: string): string {
  const line = splitHashline(truncateSerializedBlock(serialized));
  if (!line) return serialized.slice(0, PREFIX_MAX_CHARACTERS);
  const body = line.body.replace(/^\n/, "");
  const firstLine = body.split("\n")[0] ?? "";
  return toHashline(line.hash, firstLine.slice(0, PREFIX_MAX_CHARACTERS));
}
