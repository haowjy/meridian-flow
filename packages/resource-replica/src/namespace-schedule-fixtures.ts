import assert from "node:assert/strict";
import {
  planFolderDeletion,
  planFolderLocation,
  prepareFolderNamespaceAttempt,
  recordFolderNamespaceOutcome,
  settleFolderNamespaceOutcome,
  validateFolderNamespaceUpdate,
} from "./folder-namespace";

const scope = { kind: "project", projectId: "p" };
const loc = (path: string) => ({
  scheme: "manuscript",
  path: `/${path}`,
  name: path.split("/").at(-1),
  workId: null,
});
const source = {
  kind: "source",
  entryId: "s",
  name: "Files",
  scheme: "manuscript",
  scope,
  uri: "manuscript://",
};
const node = (id: string, path: string, parent = "s", kind = "folder") => ({
  kind,
  entryId: id,
  sourceId: "s",
  parentId: parent,
  scope,
  name: path.split("/").at(-1),
  path: path.split("/"),
  uri: `manuscript://${path}`,
  hasChildren: true,
  aliases: [],
  provisionalName: false,
  editable: true,
  filetype: "markdown",
  schemaType: "document",
});
const entries = [
  source,
  node("P", "P"),
  node("A", "P/A", "P"),
  node("f", "P/A/doc.md", "A", "file"),
  node("B", "B"),
];
let counter = 0;
function move(id: string, path: string, dest: string, record: any = null) {
  const d = dest.split("/");
  const name = d.pop();
  return planFolderLocation({
    record,
    projectId: "p",
    handle: id,
    folderId: id,
    source: loc(path),
    intentId: `i${++counter}`,
    operationId: `o${counter}`,
    destination: { scheme: "manuscript", workId: null, folderPath: d.join("/"), name },
  } as any)?.next;
}
function del(id: string, path: string, record: any = null) {
  return planFolderDeletion({
    record,
    projectId: "p",
    handle: id,
    folderId: id,
    source: loc(path),
    intentId: `i${++counter}`,
    operationId: `o${counter}`,
  } as any)?.next;
}
function submit(r: any) {
  return prepareFolderNamespaceAttempt(r, {
    attemptId: `a${++counter}`,
    operationId: `o${counter}`,
  })?.next;
}
function outcome(r: any, ok = false) {
  const i = r.intents.find((i: any) => i.state === "submitted");
  const a = i.attempts.at(-1);
  const request = a.request;
  const value: any = ok
    ? {
        kind: "operation",
        receipt: {
          operationId: request.body.operationId,
          command: {
            kind: request.kind,
            sourceUri: `manuscript://${request.body.path}`,
            destinationUri: `manuscript://${[request.body.destinationFolderPath, request.body.newName ?? r.canonical.name].filter(Boolean).join("/")}`,
            expected: request.body.expected,
          },
          result: {
            ok: true,
            value: {
              destinationPath: [
                request.body.destinationFolderPath,
                request.body.newName ?? r.canonical.name,
              ]
                .filter(Boolean)
                .join("/"),
            },
          },
        },
      }
    : {
        kind: "refusal",
        operationId: request.body.operationId,
        error: { code: "conflict", message: "conflict", source: "system", retryable: false },
      };
  const received = recordFolderNamespaceOutcome(r, i.intentId, a.attemptId, value)?.next;
  assert(received);
  validateFolderNamespaceUpdate(r, received);
  const settled = settleFolderNamespaceOutcome(received, 100)?.next;
  assert(settled);
  validateFolderNamespaceUpdate(received, settled);
  return settled;
}

export { del, entries, loc, move, node, outcome, submit };
