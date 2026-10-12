import type { ImportEntryReport, ImportSummary } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import type {
  CatalogContextView,
  CatalogDirectory,
  CatalogFile,
  CatalogNode,
} from "@/client/query/context-catalog-projection";
import { clientRowsFor } from "./client-rows";
import type { ImportDestination } from "./destination";
import type { ImportState } from "./import-state";
import type { Selection } from "./selection";
import { withImportRows } from "./tree-projection";

const destination: ImportDestination = {
  scheme: "kb",
  path: "/",
  uri: "kb://",
  name: "Knowledge Base",
  folderId: null,
};

function file(path: string, documentId: string, importPending = false): CatalogFile {
  return {
    kind: "file",
    entryId: documentId,
    parentId: "root",
    documentId,
    name: path.split("/").at(-1) ?? path,
    path,
    uri: `kb:/${path}`,
    provisionalName: false,
    hasProperties: false,
    importPending,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}

/** A flat catalog: the root's children are given; folders carry their own. */
function catalogOf(
  root: CatalogNode[],
  folders: Record<string, CatalogNode[]> = {},
  folderEntries: Record<string, string[]> = {},
): CatalogContextView {
  const rootDir: CatalogDirectory = {
    kind: "dir",
    entryId: "root",
    parentId: null,
    name: "Knowledge Base",
    path: "/",
    uri: "kb://",
  };
  return {
    normalized: {
      entries: new Map(
        Object.entries(folderEntries).map(([id, path]) => [id, { kind: "folder", path }]),
      ),
    } as never,
    root: rootDir,
    children: (parentId) => (parentId === "root" ? root : (folders[parentId] ?? [])),
    files: () => [],
    findPath: () => null,
    findDocument: () => null,
  };
}

const selection: Selection = {
  leftOut: [],
  roots: [
    {
      rootId: 0,
      kind: "folder",
      name: "vault",
      files: [
        { path: "Ch 1.md", file: new File(["a"], "Ch 1.md") },
        { path: "Lore/Sects.md", file: new File(["b"], "Sects.md") },
        { path: "map.png", file: new File(["c"], "map.png") },
      ],
      folders: ["Empty"],
      unreadable: [],
    },
  ],
};

function stateWith(report?: { entries: ImportEntryReport[]; rootUri: string }): ImportState {
  const rows = clientRowsFor(selection, destination, (_rootId, path) =>
    path === "Ch 1.md" ? 0 : path === "Lore/Sects.md" ? 1 : path === "map.png" ? 2 : undefined,
  );
  const summary = { importId: "i", state: "ready" } as ImportSummary;
  return {
    importId: "i",
    report: report
      ? {
          summary,
          roots: [{ rootId: 0, kind: "folder", name: "vault", id: "f", uri: report.rootUri }],
          entries: new Map(report.entries.map((e) => [e.entryId, e])),
          cursor: "1",
        }
      : null,
    local: {
      phase: { kind: "uploading" },
      destination,
      roots: [{ rootId: 0, kind: "folder", name: "vault" }],
      rows,
      total: 3,
      held: new Map(),
      manifest: null,
      failures: new Map(),
      retrying: new Set(),
    },
    load: "idle",
    refreshFailed: false,
    dismissing: false,
    dismissFailed: false,
    activitySeenAt: null,
    stop: "none",
  };
}

const entry = (
  entryId: number,
  path: string,
  state: ImportEntryReport["state"],
  uri: string,
  documentId = `d${entryId}`,
): ImportEntryReport => ({
  entryId,
  rootId: 0,
  path,
  filename: path.split("/").at(-1) ?? path,
  size: 1,
  sha256: "x",
  documentId,
  kind: "note",
  state,
  uri,
  name: path,
  reason: null,
  exists: true,
  findings: [],
});

describe("withImportRows", () => {
  it("draws every selected row among the folder's existing children before the plan answers", () => {
    const existing = file("/Sects", "existing");
    const view = withImportRows(catalogOf([existing]), "kb", [stateWith()]);
    const top = view.children("root");
    expect(top.map((n) => n.name)).toEqual(["vault", "Sects"]);
    expect(top[0].kind === "dir" && top[0].import?.client).toBe(true);
    const inside = view.children(top[0].entryId);
    expect(inside.map((n) => [n.kind, n.name])).toEqual([
      ["dir", "Empty"],
      ["dir", "Lore"],
      ["file", "Ch 1"],
      ["file", "map.png"],
    ]);
    const lore = inside.find((n) => n.name === "Lore") as CatalogNode;
    expect(view.children(lore.entryId).map((n) => n.name)).toEqual(["Sects"]);
  });

  it("takes the plan's names, hides rows the catalog now holds and keeps unlanded binaries muted", () => {
    const real = catalogOf(
      [
        {
          kind: "dir",
          entryId: "f",
          parentId: "root",
          name: "vault (2)",
          path: "/vault (2)",
          uri: "kb://vault (2)/",
        },
      ],
      {
        f: [
          file("/vault (2)/Ch 1", "d0", true),
          {
            kind: "dir",
            entryId: "lore",
            parentId: "f",
            name: "Lore",
            path: "/vault (2)/Lore",
            uri: "",
          },
        ],
        lore: [file("/vault (2)/Lore/Sects", "d1")],
      },
      { f: ["vault (2)"], lore: ["vault (2)", "Lore"] },
    );
    const view = withImportRows(real, "kb", [
      stateWith({
        rootUri: "kb://vault (2)/",
        entries: [
          entry(0, "Ch 1.md", "planned", "kb://vault (2)/Ch 1"),
          entry(1, "Lore/Sects.md", "landed", "kb://vault (2)/Lore/Sects"),
          { ...entry(2, "map.png", "planned", "kb://vault (2)/map.png"), kind: "binary" },
        ],
      }),
    ]);
    const top = view.children("root");
    expect(top).toHaveLength(1);
    expect(top[0].import?.arriving).toBe(true);
    const inside = view.children("f");
    expect(
      inside.map((n) => [n.name, Boolean(n.import?.client), Boolean(n.import?.arriving)]),
    ).toEqual([
      ["Empty", true, true],
      ["Lore", false, false],
      ["Ch 1", false, true],
      ["map.png", true, true],
    ]);
  });

  it("marks a failed file and offers Retry only while this tab holds it", () => {
    const real = catalogOf([file("/Ch 1", "d0", false)]);
    const base = stateWith({
      rootUri: "kb://vault/",
      entries: [entry(0, "Ch 1.md", "failed", "kb://Ch 1")],
    });
    const view = withImportRows(real, "kb", [base]);
    const failed = view.children("root").find((n) => n.name === "Ch 1");
    expect(failed?.import?.failure).toMatchObject({ entryId: 0, canRetry: true });
  });

  it("draws nothing for a finished import", () => {
    const state = stateWith({ rootUri: "kb://vault/", entries: [] });
    const finished: ImportState = {
      ...state,
      report: state.report && {
        ...state.report,
        summary: { ...state.report.summary, state: "finished" },
      },
    };
    const catalog = catalogOf([]);
    expect(withImportRows(catalog, "kb", [finished]).children("root")).toEqual([]);
  });
});
