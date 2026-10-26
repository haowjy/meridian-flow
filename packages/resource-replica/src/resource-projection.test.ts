/**
 * Tests resource projection behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Pending placement chooses the latest applicable intent
 */

import { expect, it } from "vitest";
import { createResourcePlacement } from "./folder-projection";
import { entries, move, node } from "./namespace-schedule-fixtures";
import { projectOptimisticSiblingOrder } from "./optimistic-sibling-order";
import { prepareNamespaceAttempt, recordNamespaceOutcome } from "./resource-namespace";
import {
  projectResourceLocation,
  resourceForDocumentIdentity,
  resourceVisibleInProject,
} from "./resource-projection";
import type { ResourceCatalogCheckpoint } from "./resource-records";
import { planResourceLocation, reserveResourceDocument } from "./resource-state";

it("projects only the requesting project's durable location intention", () => {
  const record = reserveResourceDocument({
    projectId: "project-a",
    handle: "resource",
    documentId: "document",
    databaseName: "content",
    schema: "schema",
    intentId: "create",
    provisionalName: "Untitled",
  }).next;
  record.resource.canonical = {
    scheme: "user",
    path: "/shared",
    name: "shared",
    workId: null,
  };
  const placed = planResourceLocation({
    record,
    projectId: "project-a",
    intentId: "place",
    eligibleAt: 1,
    destination: { parent: { kind: "folder", folderId: "chapters" }, name: "opening" },
  });
  if (!placed) throw new Error("Expected placement");

  expect(
    projectResourceLocation("project-a", placed.next, (id) => ({
      scheme: "manuscript",
      path: `/${id}`,
      name: id,
      workId: null,
    })),
  ).toMatchObject({
    scheme: "manuscript",
    path: "/chapters/opening",
    provisional: false,
  });
  expect(projectResourceLocation("project-b", placed.next)).toMatchObject({
    scheme: "user",
    path: "/shared",
  });
  // Lowest-level contract: naming remains complete after placement ownership retires.
  const settled = placed.next;
  settled.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  settled.intents = settled.intents.map((intent) =>
    intent.intentId === "create" ? { ...intent, state: "settled" } : intent,
  );
  const submitted = prepareNamespaceAttempt(
    settled,
    { attemptId: "file", operationId: "file" },
    (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
  );
  if (!submitted) throw new Error("Missing placement attempt");
  const received = recordNamespaceOutcome(submitted.next, "place", "file", {
    kind: "operation",
    receipt: {
      observationVersion: "1",
      operationId: "file",
      command: {
        destinationParent: { kind: "folder" as const, folderId: "chapters" },
        kind: "move",
        sourceUri: "user://shared",
        destinationUri: "manuscript://chapters/opening",
        expected: { kind: "file", nodeId: "document" },
      },
      result: { ok: true, value: { destinationPath: "chapters/opening" } },
    },
  });
  if (!received) throw new Error("Missing filing outcome");
  // Model the post-refresh state: the historical intent no longer owns placement.
  const intent = received.next.intents.find((intent) => intent.desired.kind === "set-location");
  if (!intent) throw new Error("Missing settled placement");
  intent.state = "settled";
  received.next.resource.canonical = {
    scheme: "manuscript",
    path: "/moved/opening",
    name: "opening",
    workId: null,
  };
  expect(projectResourceLocation("project-a", received.next)).toMatchObject({
    path: "/moved/opening",
    provisional: false,
  });

  // Placement replay follows durable admission order, and every unresolved placement counts, not
  // each row's latest: A→after C, B→after A, A→before C is A,C,B (latest-only gives A,B,C).
  const canonical = [
    { ...entries[0], orderPolicy: "default" as const },
    { ...node("P", "P"), orderPolicy: "default" as const },
    node("A", "P/A", "P", "file"),
    node("B", "P/B", "P", "file"),
    node("C", "P/C", "P", "file"),
  ];
  const admit = (order: number) => ({ order, scope: [], predecessors: [] });
  const reservedAt = (id: string) => {
    const reserved = reserveResourceDocument({
      projectId: "project-a",
      handle: id,
      documentId: id,
      databaseName: id,
      schema: "schema",
      intentId: `create-${id}`,
    }).next;
    reserved.resource.canonical = {
      scheme: "manuscript",
      path: `/P/${id}`,
      name: id,
      workId: null,
    };
    reserved.resource.canonicalParent = { kind: "folder", folderId: "P" };
    return reserved;
  };
  const place = (
    record: ReturnType<typeof reservedAt>,
    intentId: string,
    order: number,
    position: { kind: "before" | "after"; siblingId: string },
  ) => {
    const write = planResourceLocation({
      record,
      projectId: "project-a",
      intentId,
      eligibleAt: 1,
      admission: admit(order),
      destination: {
        parent: { kind: "folder", folderId: "P" },
        name: record.resource.handle,
        position,
      },
    });
    if (!write) throw new Error("Missing reorder");
    return write.next;
  };
  const a1 = place(reservedAt("A"), "a1", 1, { kind: "after", siblingId: "C" });
  const reordered = [
    place(a1, "a3", 3, { kind: "before", siblingId: "C" }),
    place(reservedAt("B"), "b2", 2, { kind: "after", siblingId: "A" }),
  ];
  const optimistic = projectOptimisticSiblingOrder({
    projectId: "project-a",
    canonical,
    projected: canonical,
    records: reordered,
    folders: [],
  });
  expect(
    optimistic
      .flatMap((entry) =>
        (entry.kind === "file" || entry.kind === "folder") && entry.parentId === "P" ? [entry] : [],
      )
      .sort((left, right) => (left.rank ?? "").localeCompare(right.rank ?? ""))
      .map((entry) => entry.entryId),
  ).toEqual(["A", "C", "B"]);

  // A promotion changes how later arrivals are placed: the server appends to the now-manual
  // parent even though the catalog snapshot used to build the projection still says default.
  const promotionRecord = reserveResourceDocument({
    projectId: "project-a",
    handle: "promotion",
    documentId: "B",
    databaseName: "promotion",
    schema: "schema",
    intentId: "create-promotion",
  }).next;
  promotionRecord.resource.canonical = {
    scheme: "manuscript",
    path: "/P/B",
    name: "B",
    workId: null,
  };
  promotionRecord.resource.canonicalParent = { kind: "folder", folderId: "P" };
  const promotion = planResourceLocation({
    record: promotionRecord,
    projectId: "project-a",
    intentId: "promote",
    eligibleAt: 1,
    admission: { order: 2, scope: [], predecessors: [] },
    destination: {
      parent: { kind: "folder", folderId: "P" },
      name: "B",
      position: { kind: "start" },
    },
  });
  if (!promotion) throw new Error("Missing promotion");
  const arrival = reserveResourceDocument({
    projectId: "project-a",
    handle: "arrival",
    documentId: "A",
    databaseName: "arrival",
    schema: "schema",
    intentId: "create-arrival",
  }).next;
  arrival.resource.canonical = {
    scheme: "manuscript",
    path: "/Q/A",
    name: "A",
    workId: null,
  };
  arrival.resource.canonicalParent = { kind: "folder", folderId: "Q" };
  const movedArrival = planResourceLocation({
    record: arrival,
    projectId: "project-a",
    intentId: "move-arrival",
    eligibleAt: 1,
    admission: { order: 3, scope: [], predecessors: [] },
    destination: { parent: { kind: "folder", folderId: "P" }, name: "A" },
  });
  if (!movedArrival) throw new Error("Missing arrival");
  const parentP = node("P", "P");
  const parentQ = node("Q", "Q");
  const root = entries[0];
  if (!root || parentP.kind !== "folder" || parentQ.kind !== "folder")
    throw new Error("Missing parent folders");
  const promotedThenArrived = projectOptimisticSiblingOrder({
    projectId: "project-a",
    canonical: [
      root,
      { ...parentP, orderPolicy: "default" },
      { ...parentQ, orderPolicy: "default" },
      node("A", "Q/A", "Q", "file"),
      node("B", "P/B", "P", "file"),
      node("C", "P/C", "P", "file"),
    ],
    projected: [
      root,
      { ...parentP, orderPolicy: "default" },
      { ...parentQ, orderPolicy: "default" },
      node("A", "P/A", "P", "file"),
      node("B", "P/B", "P", "file"),
      node("C", "P/C", "P", "file"),
    ],
    records: [promotion.next, movedArrival.next],
    folders: [],
  });
  expect(
    promotedThenArrived
      .flatMap((entry) =>
        (entry.kind === "file" || entry.kind === "folder") && entry.parentId === "P" ? [entry] : [],
      )
      .sort((left, right) => (left.rank ?? "").localeCompare(right.rank ?? ""))
      .map((entry) => entry.entryId),
  ).toEqual(["B", "C", "A"]);
});

it("prefers a current server identity over another resource's obsolete remint alias", () => {
  const local = reserveResourceDocument({
    projectId: "project-a",
    handle: "local-resource",
    documentId: "reminted-document",
    databaseName: "content",
    schema: "schema",
    intentId: "create",
  }).next;
  local.resource.aliases["conflicting-document"] = {
    introducedAtIdentityRevision: 2,
  };
  const server = reserveResourceDocument({
    projectId: "project-a",
    handle: "server-resource",
    documentId: "conflicting-document",
    databaseName: "server-content",
    schema: "schema",
    intentId: "server",
  }).next;

  expect(
    resourceForDocumentIdentity([local, server], "conflicting-document")?.resource.handle,
  ).toBe("server-resource");
  expect(resourceForDocumentIdentity([local], "conflicting-document")?.resource.handle).toBe(
    "local-resource",
  );
});

it("shows a document in a project only through that project's own catalogs or intents", () => {
  // Reserved by another project, so only catalogs decide visibility in project-a.
  const record = reserveResourceDocument({
    projectId: "project-x",
    handle: "resource",
    documentId: "document",
    databaseName: "content",
    schema: "schema",
    intentId: "create",
    provisionalName: "Untitled",
  }).next;
  const checkpoint = (projectId: string, listed = true): ResourceCatalogCheckpoint =>
    ({
      projectId,
      entries: listed ? [{ kind: "file", entryId: "document" }] : [],
    }) as unknown as ResourceCatalogCheckpoint;

  expect(resourceVisibleInProject("project-a", record, [checkpoint("project-a")])).toBe(true);
  expect(resourceVisibleInProject("project-a", record, [checkpoint("project-b")])).toBe(false);
  expect(resourceVisibleInProject("project-a", record, [checkpoint("project-a", false)])).toBe(
    false,
  );
  // Subtree replacement removes entries. Another catalog may still list the document.
  const catalogs = [checkpoint("project-a", false), checkpoint("project-a")];
  expect(resourceVisibleInProject("project-a", record, catalogs)).toBe(true);
  expect(resourceVisibleInProject("project-b", record, catalogs)).toBe(false);
  expect(resourceVisibleInProject("project-x", record, [])).toBe(true);
});

it("projects link-created suffix folders once per home, following the anchor until real identities arrive", () => {
  const anchor = node("anchor", "Act");
  const anchorMove = move("anchor", "Act", "Renamed");
  const records = ["first", "second"].map((id) => {
    const reserved = reserveResourceDocument({
      projectId: "p",
      handle: id,
      documentId: id,
      databaseName: id,
      schema: "schema",
      intentId: "create",
    }).next;
    const planned = planResourceLocation({
      record: reserved,
      projectId: "p",
      intentId: "file",
      eligibleAt: 1,
      destination: {
        parent: { kind: "folder", folderId: "anchor" },
        createFolders: ["New Arc", "Part 1"],
        name: `${id}`,
      },
    });
    if (!planned) throw new Error("Missing filing");
    return planned.next;
  });
  const catalog = [
    entries[0],
    anchor,
    node("first", "first", "s", "file"),
    node("second", "second", "s", "file"),
  ];
  const rows = createResourcePlacement("p", catalog, [anchorMove]).projectCatalog(catalog, records);
  expect(
    rows.flatMap((row) =>
      row.kind === "folder" && row.navigationOnly ? [row.path.join("/")] : [],
    ),
  ).toEqual(["Renamed/New Arc", "Renamed/New Arc/Part 1"]);
  expect(rows.filter((row) => row.kind === "file").map((row) => row.path.join("/"))).toEqual([
    "Renamed/New Arc/Part 1/first",
    "Renamed/New Arc/Part 1/second",
  ]);
  const real = [
    ...catalog,
    node("arc", "Act/New Arc", "anchor"),
    node("part", "Act/New Arc/Part 1", "arc"),
  ];
  const acquired = createResourcePlacement("p", real, [anchorMove]).projectCatalog(real, records);
  expect(acquired.filter((row) => row.kind === "folder" && row.navigationOnly)).toEqual([]);
  expect(acquired.filter((row) => row.kind === "file").map((row) => row.parentId)).toEqual([
    "part",
    "part",
  ]);
});

it("never calls a server-held document provisional, whatever its journal says", () => {
  const reserved = reserveResourceDocument({
    projectId: "project-a",
    handle: "resource",
    documentId: "document",
    databaseName: "content",
    schema: "schema",
    intentId: "create",
    provisionalName: "Chapter 1",
  }).next;
  // The editor's nameless create has not been placed: it invites a home.
  expect(projectResourceLocation("project-a", reserved)?.provisional).toBe(true);
  // The server holds it, and the catalog it installed carries its own provisional name.
  reserved.resource.canonical = {
    scheme: "manuscript",
    path: "/Chapter 1",
    name: "Chapter 1",
    workId: null,
  };
  reserved.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  reserved.intents = [];
  expect(projectResourceLocation("project-a", reserved)).toMatchObject({
    scheme: "manuscript",
    path: "/Chapter 1",
    name: "Chapter 1",
    provisional: false,
  });
});
