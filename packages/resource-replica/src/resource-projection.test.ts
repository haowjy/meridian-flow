import { expect, it } from "vitest";
import { createResourcePlacement } from "./folder-projection";
import { entries, move, node } from "./namespace-schedule-fixtures";
import { prepareNamespaceAttempt, recordNamespaceOutcome } from "./resource-namespace";
import { projectResourceLocation, resourceForDocumentIdentity } from "./resource-projection";
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
    path: "/shared.md",
    name: "shared.md",
    workId: null,
  };
  const placed = planResourceLocation({
    record,
    projectId: "project-a",
    intentId: "place",
    eligibleAt: 1,
    destination: { parent: { kind: "folder", folderId: "chapters" }, name: "opening.md" },
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
    path: "/chapters/opening.md",
    provisional: false,
  });
  expect(projectResourceLocation("project-b", placed.next)).toMatchObject({
    scheme: "user",
    path: "/shared.md",
  });
  // Lowest-level contract: naming remains complete after placement ownership retires.
  const settled = placed.next;
  settled.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  settled.intents = settled.intents.map((intent) =>
    intent.desired.kind === "create" ? { ...intent, state: "settled" } : intent,
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
      operationId: "file",
      command: {
        destinationParent: { kind: "folder" as const, folderId: "chapters" },
        kind: "move",
        sourceUri: "user://shared.md",
        destinationUri: "manuscript://chapters/opening.md",
        expected: { kind: "file", nodeId: "document" },
      },
      result: { ok: true, value: { destinationPath: "chapters/opening.md" } },
    },
  });
  if (!received) throw new Error("Missing filing outcome");
  // Model the post-refresh state: the historical intent no longer owns placement.
  const intent = received.next.intents.find((intent) => intent.desired.kind === "set-location");
  if (!intent) throw new Error("Missing settled placement");
  intent.state = "settled";
  received.next.resource.canonical = {
    scheme: "manuscript",
    path: "/moved/opening.md",
    name: "opening.md",
    workId: null,
  };
  expect(projectResourceLocation("project-a", received.next)).toMatchObject({
    path: "/moved/opening.md",
    provisional: false,
  });
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
        name: `${id}.md`,
      },
    });
    if (!planned) throw new Error("Missing filing");
    return planned.next;
  });
  const catalog = [
    entries[0],
    anchor,
    node("first", "first.md", "s", "file"),
    node("second", "second.md", "s", "file"),
  ];
  const rows = createResourcePlacement("p", catalog, [anchorMove]).projectCatalog(catalog, records);
  expect(
    rows.flatMap((row) =>
      row.kind === "folder" && row.navigationOnly ? [row.path.join("/")] : [],
    ),
  ).toEqual(["Renamed/New Arc", "Renamed/New Arc/Part 1"]);
  expect(rows.filter((row) => row.kind === "file").map((row) => row.path.join("/"))).toEqual([
    "Renamed/New Arc/Part 1/first.md",
    "Renamed/New Arc/Part 1/second.md",
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
