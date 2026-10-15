/** A create that joins a draft's document changes the reservation's identity and nothing else. */
import { describe, expect, it } from "vitest";
import { catalogViewFromSnapshot } from "./catalog";
import { planCatalogInstallation } from "./catalog-installation";
import { createResourcePlacement } from "./folder-projection";
import { joinReservation, pendingJoinTarget } from "./resource-join";
import {
  prepareNamespaceAttempt,
  recordNamespaceOutcome,
  settleNamespaceOutcome,
} from "./resource-namespace";
import type { NamespaceOutcome, ResourceRecord } from "./resource-records";
import { validateResourceRecordUpdate } from "./resource-records-policy";
import { planResourceLocation, reserveResourceDocument } from "./resource-state";

const root = {
  kind: "root",
  scheme: "manuscript",
  owner: { workId: null },
} as const;

const joined: Extract<NamespaceOutcome, { kind: "create" }> = {
  kind: "create",
  result: {
    status: "joined",
    documentId: "draft-document",
    address: { scheme: "manuscript", path: "Chapter 2.md", name: "Chapter 2.md", workId: null },
  },
};

/** A named reservation whose create is out, with typed content already in its exact session. */
function submitted(): ResourceRecord {
  const reservation = reserveResourceDocument({
    projectId: "project",
    handle: "handle",
    documentId: "reserved",
    databaseName: "typed-content",
    schema: "schema",
    intentId: "create",
    provisionalName: "Chapter 2.md",
    destination: { value: { parent: root, name: "Chapter 2.md" }, eligibleAt: 1 },
  }).next;
  if (reservation.resource.content.kind === "exact")
    delete reservation.resource.content.initialization;
  const attempt = prepareNamespaceAttempt(reservation, { attemptId: "attempt", operationId: "x" });
  if (!attempt) throw new Error("Expected the create to be dispatched");
  return attempt.next;
}

function answered(record: ResourceRecord): ResourceRecord {
  const received = recordNamespaceOutcome(record, "create", "attempt", joined);
  if (!received) throw new Error("Expected the answer to record");
  return received.next;
}

function catalogWithJoin(documentId: string) {
  return catalogViewFromSnapshot({
    scope: { kind: "project", projectId: "project" },
    generation: "generation",
    headRevision: "1",
    cursor: "cursor",
    entries: [
      {
        kind: "source",
        entryId: "source",
        scope: { kind: "project", projectId: "project" },
        scheme: "manuscript",
        name: "Manuscript",
        uri: "manuscript://",
      },
      {
        observationVersion: "1",
        kind: "file",
        entryId: documentId,
        scope: { kind: "project", projectId: "project" },
        sourceId: "source",
        parentId: "source",
        name: "Chapter 2.md",
        aliases: [],
        path: ["Chapter 2.md"],
        uri: "manuscript://Chapter 2.md",
        provisionalName: false,
        editable: true,
        filetype: "markdown",
        schemaType: "document",
        joinedFrom: ["reserved"],
      },
    ],
  });
}

function join(record: ResourceRecord): ResourceRecord {
  const target = pendingJoinTarget(record);
  if (!target) throw new Error("Expected a pending join");
  const write = joinReservation({ record, target, settledAt: 2 });
  if (!write) throw new Error("Expected the reservation to join");
  validateResourceRecordUpdate(record, write.next);
  return write.next;
}

describe("a create that joins a draft's document", () => {
  it("keeps the handle and typed content under the joined id, with the old id as an alias", () => {
    const record = answered(submitted());
    // Only the app can settle a join: it re-identifies the session around the commit.
    expect(settleNamespaceOutcome(record)).toBeNull();

    const next = join(record);

    expect(next.resource).toMatchObject({
      handle: "handle",
      identity: { documentId: "draft-document", revision: 2 },
      content: { kind: "exact", databaseName: "typed-content" },
      aliases: { reserved: { introducedAtIdentityRevision: 2 } },
      lifecycle: { kind: "acknowledged" },
      obligations: {
        sessionAdoption: {
          documentId: "draft-document",
          identityRevision: 2,
          exactDatabaseName: "typed-content",
        },
      },
    });
    expect(next.intents).toMatchObject([
      { intentId: "create", state: "settled", attempts: [{ outcome: { kind: "create" } }] },
    ]);
  });

  it("leaves one record whichever of the answer and the catalog entry arrives first", () => {
    const afterAnswer = join(answered(submitted()));
    const afterCatalog = planCatalogInstallation({
      projectId: "project",
      records: [submitted()],
      view: catalogWithJoin("draft-document"),
    });

    // Catalog first: the reservation follows the join and no second record is discovered.
    expect(afterCatalog.resources).toHaveLength(1);
    const followed = afterCatalog.resources[0]?.next as ResourceRecord;
    expect(followed.resource).toMatchObject({
      handle: "handle",
      identity: { documentId: "draft-document" },
      canonical: { name: "Chapter 2.md" },
    });
    expect(followed.intents).toMatchObject([{ state: "submitted" }]);
    // The late answer then finds the join done and settles without touching identity.
    const late = settleNamespaceOutcome(answered(followed));
    expect(late?.next.resource.identity).toEqual(followed.resource.identity);
    expect(late?.next.intents).toMatchObject([{ state: "settled" }]);

    // Answer first: the catalog entry matches the record by its joined id and discovers nothing.
    const afterBoth = planCatalogInstallation({
      projectId: "project",
      records: [afterAnswer],
      view: catalogWithJoin("draft-document"),
    });
    expect(afterBoth.resources.filter((write) => write.expectedRevision === null)).toEqual([]);
  });

  it("rebases a rename queued while the create was out instead of marking it for repair", () => {
    const renamed = planResourceLocation({
      record: submitted(),
      projectId: "project",
      intentId: "rename",
      eligibleAt: 1,
      destination: { parent: root, name: "Chapter 2b.md" },
    });
    if (!renamed) throw new Error("Expected the rename to queue");

    const next = join(answered(renamed.next));

    expect(next.intents).toMatchObject([
      { intentId: "create", state: "settled" },
      { intentId: "rename", state: "cancelled", identityRevision: 1 },
      { intentId: "rename@2", state: "pending", identityRevision: 2 },
    ]);
    const dispatched = prepareNamespaceAttempt(next, { attemptId: "move", operationId: "move-op" });
    expect(dispatched?.next.intents.find((intent) => intent.intentId === "rename@2")).toMatchObject(
      { state: "submitted" },
    );
  });

  it("names the reservation's parent, so a rename typed before the answer can queue", () => {
    // The rename form asks where the document sits to build its destination.
    const placement = createResourcePlacement("project", [], []);
    expect(placement.parentForResource(submitted())).toEqual(root);
  });
});
