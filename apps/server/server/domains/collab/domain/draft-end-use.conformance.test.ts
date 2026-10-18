/**
 * Contract §2.1: only an end of use ends an active draft's branch. Every production statement
 * that closes or deletes a `document_drafts` row is named here; a new one fails this test
 * until its owner decides it is an end of use and adds it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Why each file may end a branch, by the cause it retires with. */
const END_OF_USE = new Map([
  [
    "domains/collab/adapters/drizzle-branch-discard.ts",
    "Discard kernel: branch_closed, document_discarded, edit_discarded",
  ],
  [
    "domains/collab/adapters/drizzle-drafts.ts",
    "peer replacement, closed-upstream peers, retractCreate",
  ],
  ["domains/context/tree/node-rows.ts", "storage release with the tombstone"],
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "test-support" ? [] : sources(path);
    }
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

it("only the named end-of-use sites close or delete a draft branch", () => {
  const ending = sources(SERVER)
    .filter((path) => {
      const text = readFileSync(path, "utf8");
      return (
        /\.update\(documentDrafts\)\s*\.set\(\{\s*status:\s*"closed"/.test(text) ||
        /bumpDraftRevisions\([^;]*\{\s*status:\s*"closed"/.test(text) ||
        /\.delete\(documentDrafts\)/.test(text)
      );
    })
    .map((path) => relative(SERVER, path))
    .sort();
  expect(ending).toEqual([...END_OF_USE.keys()].sort());
});
