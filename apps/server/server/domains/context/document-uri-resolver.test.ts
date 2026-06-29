import { documents } from "@meridian/database/schema";
import { describe, expect, it } from "vitest";
import { resolveDocumentLocation } from "./document-uri-resolver.js";

type ResolverDb = Parameters<typeof resolveDocumentLocation>[0];
type Row = Record<string, unknown>;

type ResolverDbRows = {
  documents?: Row[];
  folders?: Row[];
};

function resolverDb(rows: ResolverDbRows): ResolverDb {
  const folderRows = [...(rows.folders ?? [])];
  return {
    select: () => ({
      from: (table: unknown) => {
        const queryRows = table === documents ? (rows.documents ?? []) : folderRows;
        return {
          innerJoin: () => ({
            where: () => ({
              limit: (count: number) => Promise.resolve(queryRows.slice(0, count)),
            }),
          }),
          where: () => ({
            limit: (count: number) => Promise.resolve(queryRows.splice(0, count)),
          }),
        };
      },
    }),
  } as unknown as ResolverDb;
}

describe("resolveDocumentLocation", () => {
  it("matches context-tree slash-prefixed paths and returns null when the document cannot resolve", async () => {
    await expect(
      resolveDocumentLocation(
        resolverDb({
          documents: [
            {
              name: "chapter-01",
              extension: "md",
              folderId: "folder-scenes",
              sourceSlug: "manuscript",
            },
          ],
          folders: [
            { id: "folder-scenes", parentId: "folder-drafts", name: "scenes" },
            { id: "folder-drafts", parentId: null, name: "drafts" },
          ],
        }),
        "nested-doc",
      ),
    ).resolves.toEqual({ scheme: "manuscript", path: "/drafts/scenes/chapter-01.md" });

    await expect(
      resolveDocumentLocation(
        resolverDb({
          documents: [{ name: "notes", extension: null, folderId: null, sourceSlug: "kb" }],
        }),
        "root-doc",
      ),
    ).resolves.toEqual({ scheme: "kb", path: "/notes" });

    await expect(
      resolveDocumentLocation(
        resolverDb({
          documents: [{ name: "notes", extension: null, folderId: null, sourceSlug: "unknown" }],
        }),
        "unknown-source-doc",
      ),
    ).resolves.toBeNull();

    await expect(
      resolveDocumentLocation(resolverDb({ documents: [] }), "missing-doc"),
    ).resolves.toBeNull();
  });
});
