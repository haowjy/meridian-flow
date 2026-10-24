/**
 * A confirmed deletion is owned by the server version that confirmed it. A strictly newer
 * server observation of the same identity as present (Apply's restore, F9) supersedes it;
 * stale pages and receipts never resurrect it.
 */
import type {
  CatalogEntry,
  CatalogSnapshot,
  ContextOperationReceipt,
} from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { installFolderNamespaceAvailability } from "./folder-namespace";
import { entries, move, node, outcome, scope, submit } from "./namespace-schedule-fixtures";
import { planResourceDeletion } from "./resource-deletion";
import type { NamespaceRequest } from "./resource-records";
import { validateResourceRecordUpdate } from "./resource-records-policy";
import { acknowledgeResourceTerminalCleanup, publishResourceTerminal } from "./resource-state";
import { ReplicaHarness } from "./test-support/replica-harness";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

const source = required(entries[0]);

const at = (version: string, rows: readonly CatalogEntry[] = entries): CatalogSnapshot => ({
  scope,
  generation: "g",
  headRevision: version,
  cursor: `c${version}`,
  entries: rows.map((row) =>
    row.kind === "source" ? row : { ...row, observationVersion: version },
  ),
});

function deleted(
  request: Extract<NamespaceRequest, { kind: "delete" }>,
  observationVersion: string,
  deletedDocumentIds: string[],
): ContextOperationReceipt {
  return {
    observationVersion,
    operationId: request.body.operationId,
    command: {
      kind: "delete",
      uri: `manuscript://${request.body.path}`,
      expected: request.body.expected,
    },
    result: {
      ok: true,
      value: {
        status: "deleted",
        removed: deletedDocumentIds.map((documentId) => ({
          documentId,
          removal: { time: "2026-01-01T00:00:00.000Z", locationVersion: "1" },
        })),
        availabilityGeneration: "9",
      },
    },
  };
}

/** P/A/doc.md known at version 1, then A deleted with its document at version 5. */
function deletedFolder(): ReplicaHarness {
  const replica = new ReplicaHarness("p");
  replica.install(at("1"));
  replica.settleFolderDeletion("A", deleted(replica.requestFolderDeletion("A"), "5", ["f"]));
  expect(replica.projection().ids).toEqual(["B", "P"]);
  expect(replica.document("f").resource.lifecycle.kind).toBe("terminal");
  return replica;
}

/** A moved, then exact-ID availability proved it deleted at version 5 (terminal witness). */
function terminalFolder(): ReplicaHarness {
  const replica = new ReplicaHarness("p");
  replica.install(at("1"));
  const known = replica.folder("A");
  const planned = move("A", "P/A", "B/A", known);
  replica.commitFolder({ expectedRevision: known.revision, next: planned });
  const submitted = submit(planned);
  replica.commitFolder({ expectedRevision: planned.revision, next: submitted });
  // outcome() validates both of its transitions (received, then settled).
  const moved = outcome(submitted, true);
  replica.folders.set(moved.handle, moved);
  const terminal = installFolderNamespaceAvailability(
    moved,
    required(moved.canonicalRefresh).operationId,
    {
      kind: "deleted",
      generation: "9",
      observationVersion: "5",
    },
  );
  replica.commitFolder(required(terminal));
  expect(replica.folder("A").terminal).toBeDefined();
  expect(replica.projection().ids).toEqual(["B", "P"]);
  return replica;
}

/** doc.md at the root, deleted alone at version 5. */
function deletedDocument(): ReplicaHarness {
  const replica = new ReplicaHarness("p");
  replica.install(at("1", [source, node("f", "doc.md", "s", "file")]));
  replica.settleDocumentDeletion("f", deleted(replica.requestDocumentDeletion("f"), "5", ["f"]));
  expect(replica.projection().ids).toEqual([]);
  return replica;
}

describe("a newer server restoration supersedes a confirmed local deletion", () => {
  it("a settled folder delete: the restored folder and its document project again", () => {
    const replica = deletedFolder();
    replica.install(at("7"));
    expect(replica.projection().ids).toEqual(["A", "B", "P", "f"]);
    expect(replica.projection().location("f")).toMatchObject({ path: "/P/A/doc.md" });
    expect(replica.document("f").resource).toMatchObject({
      lifecycle: { kind: "acknowledged" },
      content: { kind: "unacquired" },
      observationVersion: "7",
    });
    // The writer can delete the restored folder again.
    expect(() => replica.requestFolderDeletion("A")).not.toThrow();
  });

  it("a terminal folder: the restored folder and its document project again", () => {
    const replica = terminalFolder();
    const restored = at("7", [
      source,
      node("P", "P"),
      node("B", "B"),
      node("A", "B/A", "B"),
      node("f", "B/A/doc.md", "A", "file"),
    ]);
    replica.install(restored);
    expect(replica.folder("A").terminal).toBeUndefined();
    expect(replica.projection().ids).toEqual(["A", "B", "P", "f"]);
    expect(replica.projection().location("f")).toMatchObject({ path: "/B/A/doc.md" });
  });

  it("a deleted document alone reappears and can be deleted again", () => {
    const replica = deletedDocument();
    replica.install(at("7", [source, node("f", "doc.md", "s", "file")]));
    expect(replica.projection().ids).toEqual(["f"]);
    expect(planResourceDeletion(replica.document("f"), "p", "again")).not.toBeNull();
  });
});

describe("evidence at or below the deletion's version never resurrects it", () => {
  it.each([
    ["equal", "5"],
    ["older", "3"],
  ])("%s catalog pages keep a settled folder delete, its terminal documents and a terminal folder hidden", (_label, version) => {
    const folder = deletedFolder();
    folder.install(at(version));
    expect(folder.projection().ids).toEqual(["B", "P"]);
    expect(folder.document("f").resource.lifecycle.kind).toBe("terminal");

    const terminal = terminalFolder();
    terminal.install(at(version));
    expect(terminal.folder("A").terminal).toBeDefined();
    expect(terminal.projection().ids).toEqual(["B", "P"]);

    const document = deletedDocument();
    document.install(at(version, [source, node("f", "doc.md", "s", "file")]));
    expect(document.projection().ids).toEqual([]);
  });

  it("a newer page whose request began before the deletion settled waits for the next request", () => {
    const replica = new ReplicaHarness("p");
    replica.install(at("1"));
    const request = replica.requestFolderDeletion("A");
    const inFlight = replica.fence();
    replica.settleFolderDeletion("A", deleted(request, "5", ["f"]));
    replica.install(at("7"), inFlight);
    expect(replica.document("f").resource.lifecycle.kind).toBe("terminal");
    replica.install(at("7"));
    expect(replica.projection().ids).toEqual(["A", "B", "P", "f"]);
  });

  it("a document whose content purge is outstanding revives only after the purge completes", () => {
    const replica = deletedDocument();
    const terminal = replica.document("f");
    if (terminal.resource.lifecycle.kind !== "terminal") throw new Error("Not terminal");
    const transitionId = terminal.resource.lifecycle.transitionId;
    // The editor's local lineage has purge work for the exact database this device held.
    const held = structuredClone(terminal);
    held.resource.content = { kind: "exact", databaseName: "exact-f", schema: null };
    replica.records.set(held.resource.handle, held);
    const purge = {
      documentId: "f",
      generation: "9",
      transitionId,
      exactDatabaseName: "exact-f",
      deletionVersion: "5",
    };
    const purging = publishResourceTerminal({ record: held, ...purge });
    replica.commitResource(required(purging));
    const restored = at("7", [source, node("f", "doc.md", "s", "file")]);
    replica.install(restored);
    expect(replica.projection().ids).toEqual([]);
    replica.commitResource(
      required(acknowledgeResourceTerminalCleanup({ record: replica.document("f"), ...purge })),
    );
    replica.install(restored);
    expect(replica.projection().ids).toEqual(["f"]);
  });

  it("a restoration that lands before the deletion's purge leaves the purge nothing to terminalize", () => {
    const replica = new ReplicaHarness("p");
    replica.install(at("1", [source, node("f", "doc.md", "s", "file")]));
    const known = structuredClone(replica.document("f"));
    known.resource.content = { kind: "exact", databaseName: "exact-f", schema: null };
    replica.records.set(known.resource.handle, known);
    replica.settleDocumentDeletion("f", deleted(replica.requestDocumentDeletion("f"), "5", ["f"]));
    const terminal = replica.document("f").resource.lifecycle;
    if (terminal.kind !== "terminal") throw new Error("Not terminal");
    replica.install(at("7", [source, node("f", "doc.md", "s", "file")]));
    expect(replica.projection().ids).toEqual(["f"]);
    const purge = {
      documentId: "f",
      generation: terminal.generation,
      transitionId: terminal.transitionId,
      exactDatabaseName: "exact-f",
      deletionVersion: "5",
    };
    expect(publishResourceTerminal({ record: replica.document("f"), ...purge })).toBeNull();
    expect(
      acknowledgeResourceTerminalCleanup({ record: replica.document("f"), ...purge }),
    ).toBeNull();
  });

  /** f known at version 1 with local content, then the editor's exact-ID terminal and purge. */
  function editorTerminal(deletionVersion: string | null): ReplicaHarness {
    const replica = new ReplicaHarness("p");
    replica.install(at("1", [source, node("f", "doc.md", "s", "file")]));
    const known = structuredClone(replica.document("f"));
    known.resource.content = { kind: "exact", databaseName: "exact-f", schema: null };
    replica.records.set(known.resource.handle, known);
    const purge = {
      documentId: "f",
      generation: "9",
      transitionId: "editor-purge",
      exactDatabaseName: "exact-f",
      deletionVersion,
    };
    replica.commitResource(required(publishResourceTerminal({ record: known, ...purge })));
    replica.commitResource(
      required(acknowledgeResourceTerminalCleanup({ record: replica.document("f"), ...purge })),
    );
    return replica;
  }

  it("an editor terminal holds its exact-ID deletion version: older history stays deleted, a later restore revives", () => {
    const replica = editorTerminal("8");
    expect(replica.document("f").resource.lifecycle).toMatchObject({ deletionVersion: "8" });
    // A request started after the terminal can still replay presence from before the deletion.
    for (const stale of ["7", "8"]) {
      replica.install(at(stale, [source, node("f", "moved.md", "s", "file")]));
      expect(replica.document("f").resource.lifecycle.kind).toBe("terminal");
      expect(replica.projection().ids).toEqual([]);
    }
    replica.install(at("9", [source, node("f", "doc.md", "s", "file")]));
    expect(replica.document("f").resource).toMatchObject({
      lifecycle: { kind: "acknowledged" },
      content: { kind: "unacquired" },
      observationVersion: "9",
    });
    expect(replica.projection().ids).toEqual(["f"]);
  });

  it("a terminal without a deletion version never revives from a catalog page", () => {
    const replica = editorTerminal(null);
    replica.install(at("99", [source, node("f", "doc.md", "s", "file")]));
    expect(replica.document("f").resource.lifecycle.kind).toBe("terminal");
    const held = replica.document("f");
    const forced = structuredClone(held);
    forced.resource = {
      ...forced.resource,
      revision: held.resource.revision + 1,
      content: { kind: "unacquired" },
      canonical: { scheme: "manuscript", path: "/doc", name: "doc", workId: null },
      observationVersion: "99",
      lifecycle: { kind: "acknowledged", availabilityGeneration: null },
      revivedFrom: { generation: "9", transitionId: "editor-purge" },
    };
    expect(() => validateResourceRecordUpdate(held, forced)).toThrow("newer server observations");
  });

  it("a later delete receipt never lowers the editor terminal's deletion version", () => {
    const replica = new ReplicaHarness("p");
    replica.install(at("1", [source, node("f", "doc.md", "s", "file")]));
    const request = replica.requestDocumentDeletion("f");
    const known = structuredClone(replica.document("f"));
    known.resource.content = { kind: "exact", databaseName: "exact-f", schema: null };
    replica.records.set(known.resource.handle, known);
    replica.commitResource(
      required(
        publishResourceTerminal({
          record: known,
          documentId: "f",
          generation: "9",
          transitionId: "editor-purge",
          exactDatabaseName: "exact-f",
          deletionVersion: "8",
        }),
      ),
    );
    replica.settleDocumentDeletion("f", deleted(request, "5", ["f"]));
    expect(replica.document("f").resource.lifecycle).toMatchObject({ deletionVersion: "8" });
  });
});
