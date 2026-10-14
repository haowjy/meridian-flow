/** The projection rules, keyed by node id: pure inputs, no coordinator. */
import type {
  ImportEntryStatus,
  ImportFolderStatus,
  ImportStatus,
  ImportSummary,
} from "@meridian/contracts";
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
import { targetOf } from "./placements";
import { type ProjectedImport, withImportRows } from "./tree-projection";
import { type ImportedTree, rowId, rowKind, rowName } from "./tree-rows";

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
function drawn(view: ImportedTree, parentId = "root", depth = 0): string[] {
  return view.rows(parentId).flatMap((row) => {
    const mark = `${row.origin === "import" ? "*" : ""}${row.status?.arriving ? "~" : ""}${row.status?.failure ? "!" : ""}`;
    const line = `${"  ".repeat(depth)}${rowName(row)}${mark}`;
    return rowKind(row) === "dir" ? [line, ...drawn(view, rowId(row), depth + 1)] : [line];
  });
}

const summary = {
  importId: "i",
  state: "ready",
  destination: { folderUri: "kb://", folderId: null },
} as ImportSummary;
const zeroCounts = {
  total: 0,
  landed: 0,
  failed: 0,
  arriving: 0,
  deleted: 0,
  notImported: 0,
  skipped: 0,
};
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
  parentId,
  scheme: "kb",
  name: `map${entryId}`,
  extension: "png",
  reason: null,
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
  /** The server's word: counts, last activity and the picked roots as the status holds them. */
  server?: {
    counts?: Partial<ImportSummary["counts"]>;
    lastActivityAt?: string;
    roots?: ImportStatus["roots"];
  };
}): ProjectedImport {
  const state: ImportState = {
    importId: "i",
    status: parts.accepted
      ? {
          summary: {
            ...summary,
            counts: { ...zeroCounts, ...parts.server?.counts },
            lastActivityAt: parts.server?.lastActivityAt ?? new Date().toISOString(),
          },
          roots: parts.server?.roots ?? [],
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
    target: targetOf(state),
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
    const failed = view.rows("art").find((row) => rowName(row) === "map1.png");
    expect(failed?.status?.failure).toMatchObject({
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
    const marks = (view: ImportedTree, parentId = "root"): string[] =>
      view
        .rows(parentId)
        .flatMap((row) => [
          `${rowName(row)}${row.status?.notStarted ? "!" : ""}${row.status?.arriving ? "~" : ""}`,
          ...(rowKind(row) === "dir" ? marks(view, rowId(row)) : []),
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

  it("16: a refusal with no root row to carry it marks the destination, or each routed area's header", () => {
    const phase: LocalPhase = { kind: "not-started", code: "export_marker_invalid" };
    // An unreadable marker predicts no rows at all.
    const unreadable = importOf({
      rows: [],
      phase,
      held: true,
      roots: [{ rootId: 0, kind: "folder", name: "Export" }],
    });
    expect(
      withImportRows(catalogOf(), "kb", [unreadable]).statusOf("root")?.notStarted,
    ).toMatchObject({
      code: "export_marker_invalid",
    });
    // A valid export goes straight to its areas, so it has no root folder row either.
    const routed = importOf({
      rows: [{ ...row("arc", null, "dir", "Arc"), scheme: "manuscript", relPath: "Notes/Arc" }],
      phase: { kind: "not-started", code: null },
      roots: [{ rootId: 0, kind: "folder", name: "Export" }],
    });
    const manuscript = withImportRows(catalogOf(), "manuscript", [routed]);
    expect(manuscript.statusOf("root")?.notStarted).toMatchObject({ importId: "i" });
    // Another area is not its business: that view is the catalog's own.
    const kb = withImportRows(catalogOf(), "kb", [routed]);
    expect(kb.statusOf("root")).toBeUndefined();
    expect(drawn(kb)).toEqual([]);
  });

  it("5: an unlanded file stays under its folder after the writer moves it to another area", () => {
    const accepted = { folders: [folder("art", null, "Art")], entries: [entry(0, "m0", "art")] };
    const manuscript = catalogOf(dir("art", "Art"));
    const view = withImportRows(manuscript, "manuscript", [importOf({ accepted, seen: ["art"] })]);
    expect(drawn(view, "art")).toEqual(["map0.png*~"]);
    // An area the import cannot land in keeps its own view.
    const away = withImportRows(catalogOf(), "unfiled", [
      importOf({ accepted: { entries: [entry(0, "m0", "art")] }, seen: ["art"] }),
    ]);
    expect(drawn(away)).toEqual([]);
  });

  it("shows the destination as reading while the selection is read", () => {
    const reading = importOf({ phase: { kind: "reading", count: 3 }, folderId: "dest", rows: [] });
    const view = withImportRows(catalogOf(dir("dest", "Lore")), "kb", [reading]);
    expect(view.statusOf("dest")?.reading).toBe(true);
    const atRoot = withImportRows(catalogOf(), "kb", [
      importOf({ phase: { kind: "reading", count: 3 }, rows: [] }),
    ]);
    expect(atRoot.statusOf("root")?.reading).toBe(true);
  });

  it("marks the destination as preparing until the server answers", () => {
    const preparing = importOf({ phase: { kind: "preparing" }, folderId: "dest", rows: [] });
    const view = withImportRows(catalogOf(dir("dest", "Lore")), "kb", [preparing]);
    expect(view.statusOf("dest")?.preparing).toEqual({ importId: "i" });
    const answered = importOf({ phase: { kind: "preparing" }, folderId: "dest", accepted: {} });
    const after = withImportRows(catalogOf(dir("dest", "Lore")), "kb", [answered]);
    expect(after.statusOf("dest")?.preparing).toBeUndefined();
  });

  it("offers Retry only while this tab holds the files", () => {
    const accepted = {
      entries: [entry(1, "m1", null, { state: "failed", reason: "upload_failed" })],
    };
    const held = withImportRows(catalogOf(), "kb", [importOf({ accepted, held: true })]);
    expect(held.rows("root")[0]?.status?.failure?.canRetry).toBe(true);
  });
});

describe("run marks", () => {
  const book = dir("book", "Book");
  const picked: ImportStatus["roots"] = [{ rootId: 0, kind: "folder", name: "Book", id: "book" }];
  const runOf = (item: ProjectedImport) =>
    withImportRows(catalogOf(book), "kb", [item]).statusOf("book")?.run;

  it("marks a root folder sending, with how many files arrived", () => {
    const run = runOf(
      importOf({
        accepted: { entries: [entry(0, "a", null), entry(1, "b", null, { state: "landed" })] },
        held: true,
        server: { counts: { total: 2, landed: 1, arriving: 1 }, roots: picked },
      }),
    );
    expect(run).toMatchObject({ kind: "sending", arrived: 1, total: 2, remaining: 1 });
  });

  it("marks a reloaded tab's image-only import interrupted on its root, with nothing to retry", () => {
    const run = runOf(
      importOf({
        accepted: { entries: [entry(0, "img", null)] },
        server: {
          counts: { total: 1, arriving: 1 },
          lastActivityAt: "2000-01-01T00:00:00.000Z",
          roots: picked,
        },
      }),
    );
    expect(run).toMatchObject({ kind: "interrupted", arrived: 0, total: 1, canRetry: false });
  });

  it("marks failed files on the root, and offers Retry only when this tab holds them", () => {
    const server = { counts: { total: 1, failed: 1 }, roots: picked };
    const accepted = { entries: [entry(0, "img", null, { state: "failed" as const })] };
    expect(runOf(importOf({ accepted, held: true, server }))).toMatchObject({
      kind: "failed",
      canRetry: true,
    });
    expect(runOf(importOf({ accepted, server }))).toMatchObject({
      kind: "failed",
      canRetry: false,
    });
  });

  it("marks the destination when the picked root is a file", () => {
    const view = withImportRows(catalogOf(), "kb", [
      importOf({
        accepted: { entries: [entry(0, "a", null)] },
        held: true,
        server: {
          counts: { total: 1, arriving: 1 },
          roots: [{ rootId: 0, kind: "file", name: "a.png", id: null }],
        },
      }),
    ]);
    expect(view.statusOf("root")?.run?.kind).toBe("sending");
  });
});
