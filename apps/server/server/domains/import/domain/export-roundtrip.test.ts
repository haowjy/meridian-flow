/** Export spelling then import conversion: a link keeps its identity across the round trip. */
import { createHolderLinkScope } from "@meridian/markup/links";
import { describe, expect, it } from "vitest";
import { ExportLinkScope } from "../../export/domain/export-link-scope.js";
import { createLinkIndex, type ImportLinkCandidate } from "./link-index.js";
import { convertNote } from "./note-conversion.js";

// Link refs carry document ids, which are UUIDs.
const [HOLDER, ENCODED, SPACED, PERCENT] = [1, 2, 3, 4].map(
  (n) => `00000000-0000-4000-8000-00000000000${n}`,
);
const note = (id: string, path: string, uri: string): ImportLinkCandidate => ({
  id,
  path,
  uri,
  rootId: 0,
  aliases: [],
  kind: "note",
  filetype: "markdown",
});
const holder = note(HOLDER, "Manuscript/Holder.md", "manuscript://Holder");
// Literal `%20`, a literal space, and a bare `%`: three distinct names. URIs are literal.
const targets = [
  note(ENCODED, "Knowledge Base/a%20b.md", "kb://a%20b"),
  note(SPACED, "Knowledge Base/a b.md", "kb://a b"),
  note(PERCENT, "Knowledge Base/100%.md", "kb://100%"),
];

function exported(target: ImportLinkCandidate): string {
  const all = [holder, ...targets];
  const scope = new ExportLinkScope(
    holder.id,
    createHolderLinkScope(
      { uri: holder.uri, projectId: "project", view: { kind: "live" } },
      {
        document: () => null,
        documentAt: () => null,
        documentFor: () => null,
        folder: () => null,
        folderAt: () => null,
        settlement: () => null,
        assetAddress: () => null,
        assetFor: () => null,
      },
    ),
    new Map(all.map((item) => [item.id, item.path])),
    new Map(all.map((item) => [item.id, item.uri])),
    new Map(),
    new Map(),
    new Map(),
    () => {},
  );
  return scope.spellLink({ href: target.uri, ref: `doc:${target.id}` }).href;
}

describe("export then import", () => {
  it.each(targets)("binds a cross-area link to $path again", (target) => {
    const href = exported(target);
    const converted = convertNote(`[target](${href})`, {
      source: holder,
      index: createLinkIndex([holder, ...targets], []),
      attachmentFolder: "",
      aheadFolder: "manuscript://",
    });
    expect([...converted.targets.values()]).toEqual([target.id]);
  });

  it("reads a wikilink's percent literally, as note apps do", () => {
    const converted = convertNote("[[a%20b]] [[a b]]", {
      source: holder,
      index: createLinkIndex([holder, ...targets], []),
      attachmentFolder: "",
      aheadFolder: "manuscript://",
    });
    expect([...converted.targets.values()]).toEqual([ENCODED, SPACED]);
  });
});
