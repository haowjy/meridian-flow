/** Local link answers preserve the authoritative resolver's scope and ambiguity rules. */
import { expect, it } from "vitest";
import { resolveProjectedDocumentLink } from "./ProjectLinkRuntime";
import type { LinkableDocument } from "./useLinkableDocuments";

function document(
  documentId: string,
  title: string,
  uri: string,
  aliases: readonly string[] = [],
): LinkableDocument {
  return {
    documentId,
    filename: uri.split("/").at(-1) ?? title,
    title,
    uri,
    aliases,
    location: "",
    workId: null,
  };
}

it("does not claim a unique wikilink when another source has the same title", () => {
  const documents = [
    document("chapter", "Hero", "manuscript://Hero.md"),
    document("notes", "Hero", "kb://Hero.md"),
  ];

  expect(resolveProjectedDocumentLink(documents, { kind: "wikilink", name: "Hero" })).toBeNull();
});

it("does not claim a unique wikilink when another source has a matching alias", () => {
  const documents = [
    document("chapter", "Hero", "manuscript://Hero.md"),
    document("notes", "Cast", "kb://Cast.md", ["Hero"]),
  ];

  expect(resolveProjectedDocumentLink(documents, { kind: "wikilink", name: "Hero" })).toBeNull();
});

it("does not claim a unique wikilink when a noneditable file has the same title", () => {
  const documents = [
    document("chapter", "Hero", "manuscript://Hero.md"),
    document("portrait", "Hero", "uploads://Hero.pdf"),
  ];

  expect(resolveProjectedDocumentLink(documents, { kind: "wikilink", name: "Hero" })).toBeNull();
});

it("resolves an optimistic local document by its full filename", () => {
  expect(
    resolveProjectedDocumentLink([document("chapter", "Chapter", "manuscript://Chapter.md")], {
      kind: "wikilink",
      name: "Chapter.md",
    }),
  ).toMatchObject({ documentId: "chapter" });
});

it.each([
  ["knowledge", "kb://lore/Gate.md", "kb"],
  ["account", "user://Gate.md", "user"],
] as const)("resolves an optimistic explicitly addressed %s document", (documentId, uri, scheme) => {
  expect(
    resolveProjectedDocumentLink([document(documentId, "Gate", uri)], { kind: "scheme", uri }),
  ).toMatchObject({ documentId, uri, scheme });
});
