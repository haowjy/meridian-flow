import type { Filetype } from "@meridian/contracts/protocol";
import { parseDocumentFilename, renderFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  type BlobRef,
  childrenOf,
  LIVE,
  SYSTEM_ACTOR,
  sourceRoot,
  type TreeWriter,
  type View,
} from "@meridian/project-tree";
import { createDrizzleTreeListStore } from "../domains/context/adapters/drizzle-tree-list-store.js";
import { treeListOfSource } from "../domains/context/adapters/tree-list-facts.js";
import type { TreeListStore } from "../domains/context/ports/tree-list-store.js";

export { treeListOfSource };

export type SeedOptions = {
  view?: View;
  actor?: string;
  store?: Pick<TreeListStore, "submit">;
};

export type SeedDocumentOptions = SeedOptions & {
  filetype?: Filetype;
  id?: string;
  provisional?: boolean;
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

function ensureDir(
  writer: TreeWriter,
  view: View,
  actor: string,
  sourceId: string,
  dir: readonly string[],
): string {
  let parent = sourceRoot(sourceId);
  for (const name of dir) {
    const existing = childrenOf(writer.view(view), parent).find(
      (node) => node.kind === "folder" && node.name === name,
    );
    if (existing) {
      parent = existing.id;
      continue;
    }
    const created = writer.create(view, actor, { kind: "folder", name, parent });
    parent = created.node;
  }
  return parent;
}

export function treeSeeder(db: Database, deps: { documentSync?: DocumentSeeds } = {}) {
  const defaultStore = createDrizzleTreeListStore({ db });

  async function submitIn<T>(
    sourceId: string,
    options: SeedOptions,
    make: (writer: TreeWriter, view: View, actor: string) => T,
  ): Promise<T> {
    const store = options.store ?? defaultStore;
    const { result } = await store.submit({
      lists: [await treeListOfSource(db, sourceId)],
      make: ([{ writer }]) => make(writer, options.view ?? LIVE, options.actor ?? SYSTEM_ACTOR),
    });
    return result;
  }

  async function folder(sourceId: string, path: string, options: SeedOptions = {}) {
    return submitIn(sourceId, options, (writer, view, actor) => {
      const id = ensureDir(writer, view, actor, sourceId, segmentsOf(path));
      return id;
    });
  }

  async function document(sourceId: string, path: string, options: SeedDocumentOptions = {}) {
    const segments = segmentsOf(path);
    const leaf = segments.pop();
    if (!leaf) throw new Error("A seeded document needs a name");
    const parsed = parseDocumentFilename(leaf);
    if (!parsed.ok) throw new Error(`Seed name ${leaf}: ${parsed.error.message}`);
    const id = await submitIn(sourceId, options, (writer, view, actor) => {
      const parent = ensureDir(writer, view, actor, sourceId, segments);
      const created = writer.create(view, actor, {
        kind: "document",
        name: renderFilename(parsed.value.name, parsed.value.extension),
        filetype: options.filetype ?? parsed.value.filetype,
        parent,
        ...(options.id ? { node: options.id } : {}),
        ...(options.provisional ? { provisional: true as const } : {}),
      });
      return created.node;
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
      const parent = ensureDir(writer, view, actor, sourceId, segments);
      const created = writer.create(view, actor, {
        kind: "file",
        name: leaf,
        parent,
        blob,
        ...(options.id ? { node: options.id } : {}),
      });
      return created.node;
    });
  }

  return { folder, document, file, store: defaultStore };
}
