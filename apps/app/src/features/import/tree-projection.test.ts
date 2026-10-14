/** The projection rules, keyed by node id: pure inputs, no coordinator. */
import type { ImportEntryStatus, ImportFolderStatus, ImportSummary } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import type {
  CatalogContextView,
  CatalogDirectory,
  CatalogFile,
  CatalogNode,
} from "@/client/query/context-catalog-projection";
import type { ClientRow } from "./client-rows";
import type { LocalPhase } from "./display-state";
import type { ImportState } from "./import-state";
import { type ProjectedImport, withImportRows } from "./tree-projection";

type Tree =
  | { dir: string; name: string; kids: Tree[] }
  | { doc: string; name: string; pending?: true };
const dir = (id: string, name: string, kids: Tree[] = []): Tree => ({ dir: id, name, kids });
const doc = (id: string, name: string, pending = false): Tree =>
  pending ? { doc: id, name, pending: true } : { doc: id, name };

/** A catalog of nested folders and documents, as the tree would see it. */
function catalogOf(...top: Tree[]): CatalogContextView {
  const children = new Map<string, CatalogNode[]>();
  const nodes = new Map<string, CatalogNode>();
  const build = (parentId: string, items: Tree[]) => {
    children.set(
      parentId,
      items.map((item): CatalogNode => {
        if ("dir" in item) {
          const node: CatalogDirectory = {
            kind: "dir",
            entryId: item.dir,
            parentId,
            name: item.name,
            path: `/${item.name}`,
            uri: "",
          };
          nodes.set(item.dir, node);
          build(item.dir, item.kids);
          return node;
        }
        const node: CatalogFile = {
          kind: "file",
          entryId: item.doc,
          parentId,
          documentId: item.doc,
          name: item.name,
          path: `/${item.name}`,
          uri: "",
          provisionalName: false,
          hasProperties: false,
          importPending: item.pending,
          editable: true,
          filetype: "markdown",
          schemaType: "document",
        };
        nodes.set(item.doc, node);
        return node;
      }),
    );
  };
  build("root", top);
  return {
    normalized: {
      entries: new Map(
        [...nodes].map(([id, node]) => [id, { kind: node.kind === "dir" ? "folder" : "file" }]),
      ),
    } as never,
    root: { kind: "dir", entryId: "root", parentId: null, name: "KB", path: "/", uri: "kb://" },
    children: (parentId) => children.get(parentId) ?? [],
    files: () => [],
    findPath: () => null,
    findDocument: (id) => {
      const node = nodes.get(id);
      return node?.kind === "file" ? node : null;
    },
  };
}

/** The drawn tree as text: `~` arriving, `!` failed, `*` drawn by the importing tab alone. */
function drawn(view: CatalogContextView, parentId = "root", depth = 0): string[] {
  return view.children(parentId).flatMap((node) => {
    const mark = `${node.import?.client ? "*" : ""}${node.import?.arriving ? "~" : ""}${node.import?.failure ? "!" : ""}`;
    const line = `${"  ".repeat(depth)}${node.name}${mark}`;
    return node.kind === "dir" ? [line, ...drawn(view, node.entryId, depth + 1)] : [line];
  });
}

const summary = { importId: "i", state: "ready" } as ImportSummary;
const row = (
  id: string,
  parentId: string | null,
  kind: "dir" | "file",
  name: string,
): ClientRow => ({
  id,
  parentId,
  kind,
  name,
  scheme: "kb",
  rootId: 0,
  relPath: "",
});
const folder = (id: string, parentId: string | null, name: string): ImportFolderStatus => ({
  id,
  parentId,
  scheme: "kb",
  name,
  state: "landed",
});
const entry = (
  entryId: number,
  id: string,
  parentId: string | null,
  patch: Partial<ImportEntryStatus> = {},
): ImportEntryStatus => ({
  entryId,
  rootId: 0,
  path: "",
  filename: "",
  size: 1,
  sha256: "",
  documentId: id,
  kind: "binary",
  state: "planned",
  uri: null,
  parentId,
  scheme: "kb",
  name: `map${entryId}`,
  extension: "png",
  reason: null,
  exists: true,
  wanted: true,
  ...patch,
});

function importOf(parts: {
  rows?: ClientRow[];
  accepted?: { folders?: ImportFolderStatus[]; entries?: ImportEntryStatus[] };
  held?: boolean;
  phase?: LocalPhase;
  folderId?: string | null;
  roots?: NonNullable<ImportState["local"]>["roots"];
  seen?: string[];
  bridges?: string[];
}): ProjectedImport {
  const state: ImportState = {
    importId: "i",
    report: parts.accepted
      ? {
          summary,
          roots: [],
          folders: new Map((parts.accepted.folders ?? []).map((f) => [f.id, f])),
          entries: new Map((parts.accepted.entries ?? []).map((e) => [e.entryId, e])),
          cursor: "1",
        }
      : null,
    local:
      parts.rows || parts.held
        ? {
            phase: parts.phase ?? { kind: "uploading" },
            destination: {
              scheme: "kb",
              path: "/",
              uri: "kb://",
              name: "KB",
              folderId: parts.folderId ?? null,
            },
            roots: parts.roots ?? [],
            rows: parts.rows ?? [],
            held: parts.held ? new Map() : null,
            manifest: null,
            failures: new Map(),
            retrying: new Set(),
          }
        : null,
    stop: "none",
    activitySeenAt: null,
  };
  return {
    importId: "i",
    state,
    seen: new Set(parts.seen),
    bridges: new Set(parts.bridges),
  };
}

const project = (catalog: CatalogContextView, ...imports: ProjectedImport[]) =>
  drawn(withImportRows(catalog, "kb", imports));

describe("withImportRows", () => {
  const predicted = [
    row("book", null, "dir", "Book"),
    row("sub", "book", "dir", "Lore"),
    row("ch", "sub", "file", "Ch 1"),
  ];

  it("1: shows the catalog's counted-up root once and attaches predicted children under it", () => {
    const before = project(catalogOf(), importOf({ rows: predicted }));
    expect(before).toEqual(["Book*~", "  Lore*~", "    Ch 1*~"]);

    // The chunk publishes the root as "Book (2)": same id, so no second "Book".
    const after = project(catalogOf(dir("book", "Book (2)")), importOf({ rows: predicted }));
    expect(after).toEqual(["Book (2)~", "  Lore*~", "    Ch 1*~"]);
  });

  it("2: keeps an accepted plan-time row only while its bridge is open", () => {
    const accepted = {
      folders: [folder("book", null, "Book")],
      entries: [entry(0, "ch", "book", { kind: "note", name: "Ch 1", extension: "md" })],
    };
    expect(project(catalogOf(), importOf({ accepted, bridges: ["book", "ch"] }))).toEqual([
      "Book*~",
      "  Ch 1*~",
    ]);
    // No bridge: this tab never drew them, so a late tab does not invent them.
    expect(project(catalogOf(), importOf({ accepted }))).toEqual([]);
    // The catalog caught up: its row, marked arriving while the text has not landed.
    expect(
      project(
        catalogOf(dir("book", "Book", [doc("ch", "Ch 1", true)])),
        importOf({ accepted, seen: ["book", "ch"] }),
      ),
    ).toEqual(["Book~", "  Ch 1~"]);
  });

  it("3: never redraws an id the catalog held, whichever of status and catalog came first", () => {
    const accepted = {
      folders: [folder("book", null, "Book")],
      entries: [entry(0, "ch", "book", { kind: "note", name: "Ch 1", extension: "md" })],
    };
    // Created and deleted before the plan answered: seen, no longer held.
    expect(
      project(catalogOf(), importOf({ rows: predicted, seen: ["book", "sub", "ch"] })),
    ).toEqual([]);
    expect(
      project(catalogOf(), importOf({ accepted, seen: ["book", "ch"], bridges: ["book"] })),
    ).toEqual([]);
  });

  it("5: after a reload draws unlanded files muted under their folders and a failure on its row", () => {
    const accepted = {
      folders: [folder("art", null, "Art")],
      entries: [
        entry(0, "m0", "art", { state: "landing" }),
        entry(1, "m1", "art", { state: "failed", reason: "upload_failed" }),
        entry(2, "m2", "art", { state: "landed" }),
      ],
    };
    const view = withImportRows(catalogOf(dir("art", "Art", [doc("m2", "map2.png")])), "kb", [
      importOf({ accepted, seen: ["art", "m2"] }),
    ]);
    expect(drawn(view)).toEqual(["Art~", "  map0.png*~", "  map1.png*~!", "  map2.png"]);
    const failed = view.children("art").find((node) => node.name === "map1.png");
    expect(failed?.kind === "file" && failed.import?.failure).toMatchObject({
      entryId: 1,
      reason: "upload_failed",
      canRetry: false,
    });
  });

  it("6: follows the folder the writer moved, by id", () => {
    const accepted = {
      folders: [folder("art", null, "Art")],
      entries: [entry(0, "m0", "art")],
    };
    const moved = catalogOf(dir("other", "Other", [dir("art", "Art")]));
    expect(project(moved, importOf({ accepted, seen: ["art"] }))).toEqual([
      "Other",
      "  Art~",
      "    map0.png*~",
    ]);
  });

  it("7: does not return a deleted placeholder or folder, nor draw files under the folder", () => {
    const accepted = {
      folders: [folder("art", null, "Art")],
      entries: [
        entry(0, "m0", "art"),
        entry(1, "note", null, { kind: "note", name: "Ch 1", extension: "md" }),
      ],
    };
    expect(project(catalogOf(), importOf({ accepted, seen: ["art", "note"] }))).toEqual([]);
  });

  it("8: leaves a predicted row until the plan answers, and then nothing remains for it", () => {
    expect(project(catalogOf(), importOf({ rows: [row("ch", null, "file", "Ch 1")] }))).toEqual([
      "Ch 1*~",
    ]);
    const accepted = { entries: [] };
    expect(
      project(catalogOf(), importOf({ rows: [row("ch", null, "file", "Ch 1")], accepted })),
    ).toEqual([]);
  });

  it("9: after acceptance the status's folder set is authoritative", () => {
    // The prediction had `Bad/`; the plan holds no such folder, so no ghost is drawn.
    const rows = [row("book", null, "dir", "Book"), row("bad", "book", "dir", "Bad")];
    const accepted = { folders: [folder("book", null, "Book")] };
    expect(project(catalogOf(), importOf({ rows, accepted, bridges: ["book"] }))).toEqual([
      "Book*~",
    ]);
  });

  it("16: a refused plan puts the warning on the root row, or the destination for loose files", () => {
    const phase: LocalPhase = { kind: "not-started", code: "too_many_files" };
    const marks = (view: CatalogContextView, parentId = "root"): string[] =>
      view
        .children(parentId)
        .flatMap((node) => [
          `${node.name}${node.import?.notStarted ? "!" : ""}${node.import?.arriving ? "~" : ""}`,
          ...(node.kind === "dir" ? marks(view, node.entryId) : []),
        ]);
    const folderRows = [
      { ...row("book", null, "dir", "Book"), relPath: "" },
      { ...row("sub", "book", "dir", "Lore"), relPath: "Lore" },
    ];
    // Predicted rows stop saying they are arriving; only the root row warns.
    expect(
      marks(withImportRows(catalogOf(), "kb", [importOf({ rows: folderRows, phase })])),
    ).toEqual(["Book!", "Lore"]);
    // Loose files: the destination folder carries the warning.
    const loose = importOf({
      rows: [row("ch", "dest", "file", "Ch 1")],
      phase,
      folderId: "dest",
      roots: [{ rootId: 0, kind: "file", name: "Ch 1.md" }],
    });
    expect(marks(withImportRows(catalogOf(dir("dest", "Lore")), "kb", [loose]))).toEqual([
      "Lore!",
      "Ch 1",
    ]);
  });

  it("shows the destination as reading while the selection is read", () => {
    const reading = importOf({ phase: { kind: "reading", count: 3 }, folderId: "dest", rows: [] });
    const view = withImportRows(catalogOf(dir("dest", "Lore")), "kb", [reading]);
    expect(view.children("root")[0].import?.reading).toBe(true);
    const atRoot = withImportRows(catalogOf(), "kb", [
      importOf({ phase: { kind: "reading", count: 3 }, rows: [] }),
    ]);
    expect(atRoot.root.import?.reading).toBe(true);
  });

  it("offers Retry only while this tab holds the files", () => {
    const accepted = {
      entries: [entry(1, "m1", null, { state: "failed", reason: "upload_failed" })],
    };
    const held = withImportRows(catalogOf(), "kb", [importOf({ accepted, held: true })]);
    const node = held.children("root")[0];
    expect(node.kind === "file" && node.import?.failure?.canRetry).toBe(true);
  });
});
