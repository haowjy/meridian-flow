/** Fixed reviewer schedules and the exact-ID refresh boundary behind their progress guarantee. */
import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { catalogViewFromSnapshot } from "./catalog";
import {
  folderObservationFence,
  planFolderCatalogInstallation,
} from "./folder-catalog-installation";
import {
  installFolderNamespaceAvailability,
  projectFolderNeedsRepair,
  reconcileFolderNamespace,
  validateFolderNamespaceUpdate,
} from "./folder-namespace";
import { projectFolderCatalog } from "./folder-projection";
import {
  del,
  entries,
  evidence,
  loc,
  move,
  node,
  outcome,
  scope,
  submit,
} from "./namespace-schedule-fixtures";
import { committedResourceDeletion, planResourceDeletion } from "./resource-deletion";
import {
  installNamespaceAvailability,
  prepareNamespaceAttempt,
  recordNamespaceOutcome,
  settleNamespaceOutcome,
} from "./resource-namespace";
import { projectResourceLocation } from "./resource-projection";
import type {
  FolderNamespaceWrite,
  NamespaceIdentityAvailability,
  ResourceRecord,
} from "./resource-records";
import { validateResourceRecordUpdate } from "./resource-records-policy";
import { planResourceLocation } from "./resource-state";

it("binds a move to destination identity independently of record order", () => {
  const base = [entries[0], node("A", "A"), node("f", "A/doc.md", "A", "file"), node("B", "B")];
  const a = move("A", "A", "B/A"),
    b = move("B", "B", "C");
  for (const records of [
    [a, b],
    [b, a],
  ]) {
    const view = projectFolderCatalog("p", base, records);
    expect(view.find((e) => e.entryId === "A")).toMatchObject({ path: ["C", "A"], parentId: "B" });
    expect(view.find((e) => e.entryId === "f")).toMatchObject({ path: ["C", "A", "doc.md"] });
  }
});
it("falls back when a move destination disappears remotely", () => {
  const a = move("A", "P/A", "B/A");
  const view = projectFolderCatalog(
    "p",
    entries.filter((e) => e.entryId !== "B"),
    [a],
  );
  expect(view.find((e) => e.entryId === "A")).toMatchObject({ path: ["P", "A"], parentId: "P" });
});
it("suppresses moved-in children when the destination deletion settles before their move", () => {
  const a = submit(move("A", "P/A", "B/A"));
  const b = outcome(submit(del("B", "B")), true);
  for (const records of [
    [a, b],
    [b, a],
  ]) {
    const view = projectFolderCatalog(
      "p",
      entries.filter((e) => e.entryId !== "B"),
      records,
    );
    expect(view.map((e) => e.entryId)).not.toContain("A");
    expect(view.map((e) => e.entryId)).not.toContain("f");
  }
});
it("rebases child commands through refused and accepted ancestor rename chains", () => {
  const p = outcome(submit(move("P", "P", "Q")));
  const a = submit(move("A", "P/A", "Q/R"));
  for (const records of [
    [p, a],
    [a, p],
  ]) {
    expect(
      projectFolderCatalog("p", entries, records).find((e) => e.entryId === "A"),
    ).toMatchObject({ path: ["P", "R"] });
  }
  const base = [...entries, node("sub", "B/sub", "B")];
  const parent = move("B", "B", "C");
  const child = move("A", "P/A", "C/sub/A");
  expect(
    projectFolderCatalog("p", base, [child, parent]).find((e) => e.entryId === "A"),
  ).toMatchObject({ path: ["C", "sub", "A"], parentId: "sub" });
});
it("falls back for cyclic placement dependencies without choosing a record-order winner", () => {
  const a = move("A", "P/A", "B/A"),
    b = move("B", "B", "P/A/B");
  const first = projectFolderCatalog("p", entries, [a, b]);
  expect(projectFolderCatalog("p", entries, [b, a])).toEqual(first);
  expect(first.find((e) => e.entryId === "A")).toMatchObject({ path: ["P", "A"] });
});

it.each<NamespaceIdentityAvailability>([
  { observationVersion: "1", kind: "deleted", generation: "9" },
  { kind: "unavailable" },
  {
    observationVersion: "1",
    kind: "available",
    location: loc("Elsewhere/A"),
    parent: { kind: "folder", folderId: "Elsewhere" },
  },
])("resolves a queued deletion's refresh through exact identity evidence ($kind)", async (availability) => {
  let record = outcome(submit(move("A", "P/A", "B/A")), true);
  record = del("A", "P/A", record);
  const absent = catalogViewFromSnapshot({
    scope,
    generation: "g",
    headRevision: "2",
    cursor: "c",
    entries: entries.filter((e) => e.entryId !== "A" && e.entryId !== "f"),
  });
  expect(
    planFolderCatalogInstallation({
      projectId: "p",
      folders: [record],
      view: absent,
      fence: { folders: folderObservationFence([record]) },
    }).filter((write) => write.next.folderId === record.folderId),
  ).toEqual([]);
  const before = record;
  assert(before.canonicalRefresh);
  const operationId = before.canonicalRefresh.operationId;
  const commit = async (write: FolderNamespaceWrite) => {
    validateFolderNamespaceUpdate(record, write.next);
    record = write.next;
    return "committed" as const;
  };
  const result = await reconcileFolderNamespace({
    key: { handle: "A" },
    metadata: {
      accountId: "account",
      readFolder: async () => record,
      readFolders: async () => [record],
      commitFolder: commit,
    },
    transport: {
      accountId: "account",
      lookupIdentity: async (projectId, identity) => {
        expect(projectId).toBe("p");
        expect(identity).toEqual({ kind: "folder", id: "A" });
        return availability;
      },
      readOutcome: async () => null,
      submit: async () => {
        throw new Error("Refresh must precede dispatch");
      },
    },
    lock: {
      accountId: "account",
      run: async (_key, task) => ({ kind: "acquired", value: await task() }),
    },
    newAttemptIds: () => ({ attemptId: "next", operationId: "next" }),
  });
  expect(result).toBe("progressed");
  expect(record.canonicalRefresh).toBeUndefined();
  const deletion = record.intents.find((i) => i.desired.kind === "delete");
  assert(deletion);
  if (availability.kind === "deleted") {
    expect(deletion.state).toBe("unexecutable-after-terminal");
    expect(record.terminal).toEqual({ generation: "9" });
    expect(projectFolderCatalog("p", entries, [record]).some((e) => e.entryId === "A")).toBe(false);
  } else if (availability.kind === "unavailable") {
    expect(deletion.state).toBe("needs-repair");
    expect(projectFolderNeedsRepair(record)?.kind).toBe("delete");
    expect(projectFolderCatalog("p", entries, [record]).some((e) => e.entryId === "A")).toBe(true);
  } else {
    expect(deletion.state).toBe("pending");
    expect(record.canonical).toEqual(availability.location);
  }
  // A response for an older barrier cannot resolve new work.
  expect(installFolderNamespaceAvailability(record, operationId, availability)).toBeNull();
});

it.each<NamespaceIdentityAvailability>([
  { observationVersion: "1", kind: "deleted", generation: "9" },
  { kind: "unavailable" },
  {
    observationVersion: "1",
    kind: "available",
    location: loc("B/doc.md"),
    parent: { kind: "folder", folderId: "B" },
  },
])("releases file refresh into canonical progress or repair ($kind)", (availability) => {
  let record = acknowledgedFile();
  const apply = (write: { next: ResourceRecord } | null) => {
    assert(write);
    validateResourceRecordUpdate(record, write.next);
    record = write.next;
  };
  apply(
    planResourceLocation({
      record,
      projectId: "p",
      intentId: "move",
      eligibleAt: 1,
      destination: { parent: { kind: "folder", folderId: "B" }, name: "doc.md" },
    }),
  );
  apply(
    prepareNamespaceAttempt(record, { attemptId: "attempt", operationId: "operation" }, (id) => ({
      scheme: "manuscript",
      path: `/${id}`,
      name: id,
      workId: null,
    })),
  );
  const attempt = record.intents[0].attempts[0];
  apply(recordNamespaceOutcome(record, "move", "attempt", evidence(attempt, false)));
  apply(settleNamespaceOutcome(record, 100));
  apply(planResourceDeletion(record, "p", "delete"));
  apply(installNamespaceAvailability(record, "operation", availability));
  expect(record.resource.obligations.canonicalRefresh).toBeUndefined();
  expect(record.resource.lifecycle.kind).toBe("acknowledged");
  expect(record.intents.at(-1)?.state).toBe(
    availability.kind === "available" ? "pending" : "needs-repair",
  );
  if (availability.kind !== "available")
    expect(projectResourceLocation("p", record)).not.toBeNull();
});

it.each([
  "accepted",
  "refusal",
  "refused-receipt",
] as const)("terminal file absorbs late %s evidence without applying it", (disposition) => {
  let record = acknowledgedFile();
  const apply = (write: { next: ResourceRecord } | null) => {
    assert(write);
    validateResourceRecordUpdate(record, write.next);
    record = write.next;
  };
  apply(
    planResourceLocation({
      record,
      projectId: "p",
      intentId: "move",
      eligibleAt: 1,
      destination: { parent: { kind: "folder", folderId: "B" }, name: "doc.md" },
    }),
  );
  apply(
    prepareNamespaceAttempt(record, { attemptId: "attempt", operationId: "operation" }, (id) => ({
      scheme: "manuscript",
      path: `/${id}`,
      name: id,
      workId: null,
    })),
  );
  const attempt = record.intents[0].attempts[0];
  const result = evidence(attempt, disposition !== "accepted", disposition === "refusal");
  apply({
    next: {
      ...record,
      resource: {
        ...committedResourceDeletion(record.resource, "9", "parent-delete"),
        revision: record.resource.revision + 1,
      },
    },
  });
  apply(recordNamespaceOutcome(record, "move", "attempt", result));
  apply(settleNamespaceOutcome(record, 100));
  expect(record.intents[0].state).toBe("unexecutable-after-terminal");
  expect(record.intents[0].attempts[0].outcome).toEqual(result);
  expect(record.resource.obligations.canonicalRefresh).toBeUndefined();
  expect(projectResourceLocation("p", record)).toBeNull();
});
function acknowledgedFile(): ResourceRecord {
  return {
    resource: {
      handle: "f",
      revision: 1,
      identity: { documentId: "f", revision: 1 },
      content: { kind: "unacquired" },
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
      canonical: loc("P/A/doc.md"),
      lifecycle: { kind: "acknowledged", availabilityGeneration: "1" },
      aliases: {},
      obligations: {},
    },
    intents: [],
  };
}

it("keeps authoritative refreshed folder placement ahead of an older catalog checkpoint", () => {
  const moved = outcome(submit(move("A", "P/A", "B/A")), true);
  const refreshed = installFolderNamespaceAvailability(moved, moved.canonicalRefresh!.operationId, {
    observationVersion: "1",
    kind: "available",
    location: loc("B/A"),
    parent: { kind: "folder", folderId: "B" },
  });
  assert(refreshed);
  validateFolderNamespaceUpdate(moved, refreshed.next);
  const view = projectFolderCatalog("p", entries, [refreshed.next]);
  expect(view.find((e) => e.entryId === "A")).toMatchObject({ path: ["B", "A"], parentId: "B" });
  expect(view.find((e) => e.entryId === "f")).toMatchObject({ path: ["B", "A", "doc.md"] });
});

it("retires dependency cycles to a fixed point when canonical parents expose another cycle", () => {
  const base = [entries[0], node("C", "C"), node("A", "C/A", "C"), node("B", "B")];
  const a = move("A", "C/A", "B/A"),
    b = move("B", "B", "C/A/B"),
    c = move("C", "Elsewhere/C", "C/A/C");
  const shifted = c;
  const first = projectFolderCatalog("p", base, [a, b, shifted]);
  expect(projectFolderCatalog("p", base, [shifted, b, a])).toEqual(first);
});
