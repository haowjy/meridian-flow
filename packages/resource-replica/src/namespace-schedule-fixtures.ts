/** Deterministic, validated journal commands and transport evidence for schedule invariants. */
import assert from "node:assert/strict";
import type { CatalogEntry } from "@meridian/contracts/protocol";
import {
  planFolderDeletion,
  planFolderLocation,
  prepareFolderNamespaceAttempt,
  recordFolderNamespaceOutcome,
  settleFolderNamespaceOutcome,
  validateFolderNamespaceUpdate,
} from "./folder-namespace";
import type {
  FolderNamespaceRecord,
  NamespaceAttempt,
  NamespaceOutcome,
  ResourceLocation,
} from "./resource-records";

export const scope = { kind: "project" as const, projectId: "p" };
export const loc = (path: string): ResourceLocation => ({
  scheme: "manuscript",
  path: `/${path}`,
  name: path.split("/").at(-1)!,
  workId: null,
});
export function node(
  id: string,
  path: string,
  parent = "s",
  kind: "folder" | "file" = "folder",
): CatalogEntry {
  const shared = {
    entryId: id,
    sourceId: "s",
    parentId: parent,
    scope,
    name: path.split("/").at(-1)!,
    path: path.split("/"),
    uri: `manuscript://${path}`,
  };
  return kind === "folder"
    ? { ...shared, kind, hasChildren: true }
    : {
        ...shared,
        kind,
        aliases: [],
        provisionalName: false,
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      };
}
export const entries: readonly CatalogEntry[] = [
  {
    kind: "source",
    entryId: "s",
    name: "Files",
    scheme: "manuscript",
    scope,
    uri: "manuscript://",
  },
  node("P", "P"),
  node("A", "P/A", "P"),
  node("f", "P/A/doc.md", "A", "file"),
  node("B", "B"),
];
let counter = 0;
export function permutations<T>(items: readonly T[]): T[][] {
  return items.length
    ? items.flatMap((item, i) =>
        permutations(items.filter((_, j) => i !== j)).map((rest) => [item, ...rest]),
      )
    : [[]];
}
export function move(
  id: string,
  path: string,
  destination: string,
  record: FolderNamespaceRecord | null = null,
) {
  const parts = destination.split("/");
  const name = parts.pop()!;
  const write = planFolderLocation({
    record,
    projectId: "p",
    handle: id,
    folderId: id,
    source: loc(path),
    intentId: `i${++counter}`,
    operationId: `o${counter}`,
    destination: { scheme: "manuscript", workId: null, folderPath: parts.join("/"), name },
  });
  assert(write);
  validateFolderNamespaceUpdate(record, write.next);
  return write.next;
}
export function del(id: string, path: string, record: FolderNamespaceRecord | null = null) {
  const write = planFolderDeletion({
    record,
    projectId: "p",
    handle: id,
    folderId: id,
    source: loc(path),
    intentId: `i${++counter}`,
    operationId: `o${counter}`,
  });
  assert(write);
  validateFolderNamespaceUpdate(record, write.next);
  return write.next;
}
export function submit(record: FolderNamespaceRecord) {
  const write = prepareFolderNamespaceAttempt(record, {
    attemptId: `a${++counter}`,
    operationId: `o${counter}`,
  });
  assert(write);
  validateFolderNamespaceUpdate(record, write.next);
  return write.next;
}
export function evidence(
  attempt: NamespaceAttempt,
  refused: boolean,
  receiptless = true,
): NamespaceOutcome {
  const request = attempt.request;
  assert(request.kind !== "create");
  if (refused && receiptless)
    return {
      kind: "refusal",
      operationId: request.body.operationId,
      error: { code: "conflict", message: "Conflict", source: "system", retryable: false },
    };
  const error = {
    ok: false as const,
    error: { code: "conflict" as const, uri: `manuscript://${request.body.path}` },
  };
  if (request.kind === "delete")
    return {
      kind: "operation",
      receipt: {
        operationId: request.body.operationId,
        command: {
          kind: "delete",
          uri: `manuscript://${request.body.path}`,
          expected: request.body.expected,
        },
        result: refused
          ? error
          : {
              ok: true,
              value: {
                status: "deleted",
                deletedDocumentIds:
                  request.body.expected.kind === "file" ? [request.body.expected.documentId] : [],
                availabilityGeneration: "9",
              },
            },
      },
    };
  const destinationPath = [
    request.body.destinationFolderPath,
    request.body.newName ?? request.body.path.split("/").at(-1)!,
  ]
    .filter(Boolean)
    .join("/");
  return {
    kind: "operation",
    receipt: {
      operationId: request.body.operationId,
      command: {
        kind: "move",
        sourceUri: `manuscript://${request.body.path}`,
        destinationUri: `manuscript://${destinationPath}`,
        expected: request.body.expected,
      },
      result: refused ? error : { ok: true, value: { destinationPath } },
    },
  };
}
export function outcome(record: FolderNamespaceRecord, accepted = false) {
  const intent = record.intents.find((i) => i.state === "submitted");
  assert(intent);
  const attempt = intent.attempts.at(-1);
  assert(attempt);
  const received = recordFolderNamespaceOutcome(
    record,
    intent.intentId,
    attempt.attemptId,
    evidence(attempt, !accepted),
  );
  assert(received);
  validateFolderNamespaceUpdate(record, received.next);
  const settled = settleFolderNamespaceOutcome(received.next, 100);
  assert(settled);
  validateFolderNamespaceUpdate(received.next, settled.next);
  return settled.next;
}
