import assert from "node:assert/strict";
import { expect, it } from "vitest";
import * as folder from "./folder-namespace";
import { committedResourceDeletion, planResourceDeletion } from "./resource-deletion";
import { intentOwnsDeletion } from "./resource-intent-policy";
import * as ns from "./resource-namespace";
import { projectResourceLocation } from "./resource-projection";
import { validateResourceRecordUpdate } from "./resource-records-policy";
import { planResourceLocation } from "./resource-state";

const loc = (path: string) => ({
  scheme: "manuscript",
  path: `/${path}`,
  name: path.split("/").at(-1),
  workId: null,
});
function permutations(a: string[]): string[][] {
  return a.length
    ? a.flatMap((x, i) => permutations(a.filter((_, j) => i !== j)).map((p) => [x, ...p]))
    : [[]];
}
it("validates and drains all file/folder journal schedules", () => {
  const results: any[] = [];
  let passed = 0;
  let _assertions = 0;
  for (const kind of ["file", "folder"])
    for (const receiptless of [true, false])
      for (const auto of [true, false])
        for (const order of permutations([
          "move",
          "rename",
          "delete",
          "refusal",
          "remote-delete",
        ])) {
          let seq = 0,
            remote = false,
            admittedDelete = false;
          let r: any =
            kind === "file"
              ? {
                  resource: {
                    handle: "x",
                    revision: 1,
                    identity: { documentId: "x", revision: 1 },
                    content: { kind: "unacquired" },
                    classification: {
                      editable: true,
                      filetype: "markdown",
                      schemaType: "document",
                    },
                    canonical: loc("A"),
                    lifecycle: { kind: "acknowledged", availabilityGeneration: "1" },
                    aliases: {},
                    obligations: {},
                  },
                  intents: [],
                }
              : {
                  projectId: "p",
                  handle: "x",
                  folderId: "x",
                  revision: 0,
                  canonical: loc("A"),
                  intents: [],
                };
          const validate =
            kind === "file" ? validateResourceRecordUpdate : folder.validateFolderNamespaceUpdate;
          const apply = (w: any) => {
            if (w) {
              validate(r, w.next);
              r = w.next;
            }
          };
          const prep = () =>
            apply(
              (kind === "file" ? ns.prepareNamespaceAttempt : folder.prepareFolderNamespaceAttempt)(
                r,
                { attemptId: `a${++seq}`, operationId: `o${seq}` },
              ),
            );
          const resolve = (refused: boolean) => {
            const i = r.intents.find((i: any) => i.state === "submitted");
            if (!i) return;
            const a = i.attempts.at(-1),
              q = a.request;
            const refusal = {
              kind: "refusal",
              operationId: q.body.operationId,
              error: { code: "conflict", message: "No", source: "system", retryable: false },
            };
            const command =
              q.kind === "delete"
                ? { kind: "delete", uri: `manuscript://${q.body.path}`, expected: q.body.expected }
                : {
                    kind: "move",
                    sourceUri: `manuscript://${q.body.path}`,
                    destinationUri: `manuscript://${[q.body.destinationFolderPath, q.body.newName ?? "A"].filter(Boolean).join("/")}`,
                    expected: q.body.expected,
                  };
            const result = refused
              ? { ok: false, error: { code: "conflict", uri: "manuscript://A" } }
              : {
                  ok: true,
                  value: {
                    status: "deleted",
                    deletedDocumentIds: kind === "file" ? ["x"] : [],
                    availabilityGeneration: "9",
                  },
                };
            const out =
              refused && receiptless
                ? refusal
                : {
                    kind: "operation",
                    receipt: { operationId: q.body.operationId, command, result },
                  };
            apply(
              (kind === "file" ? ns.recordNamespaceOutcome : folder.recordFolderNamespaceOutcome)(
                r,
                i.intentId,
                a.attemptId,
                out as any,
              ),
            );
            apply(
              (kind === "file" ? ns.settleNamespaceOutcome : folder.settleFolderNamespaceOutcome)(
                r,
                100,
              ),
            );
          };
          let at = "";
          try {
            for (const event of order) {
              at = event;
              if (event === "remote-delete") {
                remote = true;
                if (kind === "file")
                  apply({
                    next: {
                      ...r,
                      resource: {
                        ...committedResourceDeletion(r.resource, "9", "remote"),
                        revision: r.resource.revision + 1,
                      },
                    },
                  });
              } else if (event === "refusal") resolve(true);
              else if (!remote && !r.intents.some(intentOwnsDeletion)) {
                if (event === "delete") {
                  apply(
                    kind === "file"
                      ? planResourceDeletion(r, "p", `i${++seq}`)
                      : folder.planFolderDeletion({
                          record: r,
                          projectId: "p",
                          handle: "x",
                          folderId: "x",
                          source: r.canonical,
                          intentId: `i${++seq}`,
                          operationId: `o${seq}`,
                        }),
                  );
                  admittedDelete = true;
                } else {
                  const path =
                    kind === "file"
                      ? projectResourceLocation("p", r)
                      : folder.projectFolderLocation(r);
                  assert(path);
                  const dest = {
                    scheme: "manuscript",
                    workId: null,
                    folderPath:
                      event === "move" ? "B" : path.path.split("/").slice(1, -1).join("/"),
                    name: event === "rename" ? "Renamed" : path.name,
                  };
                  apply(
                    kind === "file"
                      ? planResourceLocation({
                          record: r,
                          projectId: "p",
                          intentId: `i${++seq}`,
                          eligibleAt: 1,
                          destination: dest as any,
                        })
                      : folder.planFolderLocation({
                          record: r,
                          projectId: "p",
                          handle: "x",
                          folderId: "x",
                          source: r.canonical,
                          intentId: `i${++seq}`,
                          operationId: `o${seq}`,
                          destination: dest as any,
                        }),
                  );
                }
              }
              if (auto) prep();
              if (remote && kind === "file") {
                assert.equal(projectResourceLocation("p", r), null);
                _assertions++;
              }
            }
            at = "drain";
            for (let j = 0; j < 8; j++) {
              prep();
              const active = ns.activeNamespaceIntent(r);
              if (active?.state !== "submitted") break;
              resolve(active.desired.kind !== "delete");
            }
            if (admittedDelete && !remote) {
              assert.equal(ns.activeNamespaceIntent(r), null);
              assert(
                r.intents.some((i: any) => i.desired.kind === "delete" && i.state === "settled"),
              );
              _assertions += 2;
            }
            if (remote && kind === "file") {
              assert.equal(r.resource.lifecycle.kind, "terminal");
              assert.equal(projectResourceLocation("p", r), null);
              _assertions += 2;
            }
            passed++;
          } catch (e) {
            results.push({
              kind,
              receiptless,
              auto,
              order,
              at,
              error: String(e),
              states: r.intents.map((i: any) => i.state),
              failedDesired: r.intents.find((i: any) => i.state === "received")?.desired.kind,
              remote,
              admittedDelete,
            });
          }
        }
  expect(results).toEqual([]);
  expect(passed).toBe(960);
});
