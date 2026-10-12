/**
 * Import link resolution and frontmatter parsing cost at vault scale. Pure, no
 * database. Not a correctness gate; records timings.
 *
 *   pnpm --filter @meridian/server exec tsx scripts/probe-link-resolution.ts
 *
 * Prints one JSON line per measurement.
 */
import { readFrontmatter } from "../server/domains/context/frontmatter.js";
import {
  createLinkIndex,
  type ImportLinkCandidate,
} from "../server/domains/import/domain/link-index.js";
import { convertObsidianNote } from "../server/domains/import/domain/obsidian-note.js";

const candidate = (path: string, aliases: string[], uri: string): ImportLinkCandidate => ({
  id: path,
  path,
  uri,
  rootId: 0,
  aliases,
  kind: "note",
  filetype: "markdown",
});
const timed = <T>(run: () => T): [T, number] => {
  const started = performance.now();
  const value = run();
  return [value, performance.now() - started];
};

// 2,000 links against 10,000 selected and 10,000 existing candidates.
const pool = Array.from({ length: 10_000 }, (_, index) =>
  candidate(
    `Folder ${index % 97}/Note ${index}.md`,
    index % 13 ? [] : [`Alias ${index}`],
    `kb://vault/Folder ${index % 97}/Note ${index}`,
  ),
);
const existing = Array.from({ length: 10_000 }, (_, index) =>
  candidate(`Old ${index}.md`, [], `kb://Archive ${index % 89}/Old ${index}`),
);
const text = Array.from({ length: 2_000 }, (_, index) =>
  index % 4 === 0
    ? `[[Note ${index * 5}]]`
    : index % 4 === 1
      ? `[[Alias ${index * 13}]]`
      : index % 4 === 2
        ? `[[Old ${index * 5}]]`
        : `[[Missing ${index}]]`,
).join(" ");
const [converted, linksMs] = timed(() =>
  convertObsidianNote(text, {
    source: pool[0],
    index: createLinkIndex(pool, existing),
    attachmentFolder: "",
    aheadFolder: "kb://vault/",
  }),
);
console.info(
  JSON.stringify({
    phase: "links",
    links: 2_000,
    selected: pool.length,
    existing: existing.length,
    bound: converted.targets.size,
    ms: linksMs,
  }),
);

// Frontmatter at the size cap, and over it (not parsed).
const keys = Array.from({ length: 2_000 }, (_, index) => `key${index}: value`).join("\n");
const [, atCapMs] = timed(() =>
  readFrontmatter(`${keys}\n#${" ".repeat(32_768 - keys.length - 2)}`),
);
const over = Array.from({ length: 20_000 }, (_, index) => `key${index}: value`).join("\n");
const [, overCapMs] = timed(() => readFrontmatter(over));
console.info(JSON.stringify({ phase: "frontmatter", atCapMs, overCapMs }));
