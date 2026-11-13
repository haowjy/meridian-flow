/**
 * Seeds a tree for a test through the one path that writes it: `treeListStore.submit`. Folders,
 * documents and files go into a source's list (a project's, or the account's for `user://`),
 * live or in a Work's draft view, and every helper returns the id it made. Paths are
 * source-relative (`Arc 1/Chapter 1.md`); folders on the way are reused by name or created.
 *
 * Nothing here inserts a `documents` or `tree_nodes` row: the rows are the store's replay.
 */
import type { Filetype } from "@meridian/contracts/protocol";
import { parseDocumentFilename, renderFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  type BlobRef,
  childrenOf,
  LIVE,
  sourceRoot,
  type TreeRecord,
  type TreeWriter,
  type View,
} from "@meridian/project-tree";
import { createDrizzleJournal } from "../domains/collab/adapters/drizzle-journal.js";
import { createDrizzleTreeListStore } from "../domains/context/adapters/drizzle-tree-list-store.js";
import { treeListOfSource } from "../domains/context/adapters/tree-list-facts.js";
import type { TreeListStore } from "../domains/context/ports/tree-list-store.js";

export { treeListOfSource };

export type SeedOptions = {
  /** `LIVE` (default) or a Work's draft view, `{ draft: branchId }`. */
  view?: View;
  /** The record's actor; default `system`. */
  actor?: string;
  /** Another store than the one `treeSeeder` made, when a test composes its own. */
  store?: Pick<TreeListStore, "submit">;
};

export type SeedDocumentOptions = SeedOptions & {
  /** The document's type; default from the extension (markdown for a bare name). */
  filetype?: Filetype;
  /** A node id of the caller's choosing. */
  id?: string;
  provisional?: boolean;
  /** Text to seed into the document's journal; needs `documentSync` on the seeder. */
  text?: string;
};

type DocumentSeeds = {
  bindStatic(markdown: string): unknown;
  seedFromMarkdown(
    documentId: string,
    content: never,
    origin: { type: "system" },
  ): Promise<{ ok: boolean }>;
};

function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Folders along `dir` in the view: the ones that exist are reused, the rest made. */
function ensureDir(
  writer: TreeWriter,
  view: View,
  actor: string,
  sourceId: string,
  dir: readonly string[],
  made: TreeRecord[],
): string {
  let parent = sourceRoot(sourceId);
  for (const name of dir) {
    const existing = childrenOf(writer.view(view), parent).find(
      (node) => node.kind === "folder" && node.displayName === name,
    );
    if (existing) {
      parent = existing.id;
      continue;
    }
    const created = writer.create(view, actor, { kind: "folder", name, parent });
    made.push(created);
    parent = created.node;
  }
  return parent;
}

export function treeSeeder(db: Database, deps: { documentSync?: DocumentSeeds } = {}) {
  const defaultStore = createDrizzleTreeListStore({ db, journal: createDrizzleJournal(db) });

  async function submitIn<T>(
    sourceId: string,
    options: SeedOptions,
    make: (writer: TreeWriter, view: View, actor: string) => { records: TreeRecord[]; result: T },
  ): Promise<T> {
    const store = options.store ?? defaultStore;
    const { result } = await store.submit({
      list: await treeListOfSource(db, sourceId),
      make: (writer) => make(writer, options.view ?? LIVE, options.actor ?? "system"),
    });
    return result;
  }

  /** The folder at `path` (every folder on the way made if absent); returns the leaf's id. */
  async function folder(sourceId: string, path: string, options: SeedOptions = {}) {
    return submitIn(sourceId, options, (writer, view, actor) => {
      const made: TreeRecord[] = [];
      const id = ensureDir(writer, view, actor, sourceId, segmentsOf(path), made);
      return { records: made, result: id };
    });
  }

  /** A document at `path`, its folders made as needed. A taken name is numbered, as any create's is. */
  async function document(sourceId: string, path: string, options: SeedDocumentOptions = {}) {
    const segments = segmentsOf(path);
    const leaf = segments.pop();
    if (!leaf) throw new Error("A seeded document needs a name");
    const parsed = parseDocumentFilename(leaf);
    if (!parsed.ok) throw new Error(`Seed name ${leaf}: ${parsed.error.message}`);
    const id = await submitIn(sourceId, options, (writer, view, actor) => {
      const made: TreeRecord[] = [];
      const parent = ensureDir(writer, view, actor, sourceId, segments, made);
      const created = writer.create(view, actor, {
        kind: "document",
        name: renderFilename(parsed.value.name, parsed.value.extension),
        filetype: options.filetype ?? parsed.value.filetype,
        parent,
        ...(options.id ? { node: options.id } : {}),
        ...(options.provisional ? { provisional: true as const } : {}),
      });
      made.push(created);
      return { records: made, result: created.node };
    });
    if (options.text !== undefined) {
      const sync = deps.documentSync;
      if (!sync) throw new Error("Seeding text needs a documentSync on the seeder");
      const seeded = await sync.seedFromMarkdown(id, sync.bindStatic(options.text) as never, {
        type: "system",
      });
      if (!seeded.ok) throw new Error(`Seeding text into ${path} failed`);
    }
    return id;
  }

  /** A stored file (its bytes are in storage; `blob` points at them) at `path`. */
  async function file(
    sourceId: string,
    path: string,
    blob: BlobRef,
    options: SeedOptions & { id?: string } = {},
  ) {
    const segments = segmentsOf(path);
    const leaf = segments.pop();
    if (!leaf) throw new Error("A seeded file needs a name");
    return submitIn(sourceId, options, (writer, view, actor) => {
      const made: TreeRecord[] = [];
      const parent = ensureDir(writer, view, actor, sourceId, segments, made);
      const created = writer.create(view, actor, {
        kind: "file",
        name: leaf,
        parent,
        blob,
        ...(options.id ? { node: options.id } : {}),
      });
      made.push(created);
      return { records: made, result: created.node };
    });
  }

  return { folder, document, file, store: defaultStore };
}
