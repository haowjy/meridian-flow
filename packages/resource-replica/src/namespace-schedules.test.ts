/** Schedule invariants across both namespace journals, including terminal and refresh boundaries. */
import assert from "node:assert/strict";
import { expect, it } from "vitest";
import {
  installFolderCanonicalRefresh,
  planFolderDeletion,
  planFolderLocation,
  prepareFolderNamespaceAttempt,
  projectFolderNeedsRepair,
  recordFolderNamespaceOutcome,
  settleFolderNamespaceOutcome,
  validateFolderNamespaceUpdate,
} from "./folder-namespace";
import { projectFolderCatalog } from "./folder-projection";
import { entries, evidence, loc, permutations } from "./namespace-schedule-fixtures";
import { committedResourceDeletion, planResourceDeletion } from "./resource-deletion";
import { intentOwnsDeletion } from "./resource-intent-policy";
import {
  activeNamespaceIntent,
  installCanonicalRefresh,
  prepareNamespaceAttempt,
  recordNamespaceOutcome,
  settleNamespaceOutcome,
} from "./resource-namespace";
import { projectResourceLocation, projectResourceNeedsRepair } from "./resource-projection";
import type {
  FolderNamespaceRecord,
  NamespaceIntent,
  ResourceDestination,
  ResourceRecord,
} from "./resource-records";
import { validateResourceRecordUpdate } from "./resource-records-policy";
import { planResourceLocation } from "./resource-state";

type Event = "move" | "rename" | "delete" | "refusal" | "remote-delete" | "catalog-refresh";
type Machine = {
  intents(): readonly NamespaceIntent[];
  terminal(): boolean;
  hidden(): boolean;
  repair(): boolean;
  place(destination: ResourceDestination): void;
  remove(): void;
  remoteDelete(): void;
  prepare(): void;
  resolve(refused: boolean, receiptless: boolean): void;
  refresh(): void;
};
function fileMachine(): Machine {
  let record: ResourceRecord = {
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
  validateResourceRecordUpdate(null, record);
  let sequence = 0;
  const apply = (write: { next: ResourceRecord } | null) => {
    if (write) {
      validateResourceRecordUpdate(record, write.next);
      record = write.next;
    }
  };
  return {
    intents: () => record.intents,
    terminal: () => record.resource.lifecycle.kind === "terminal",
    hidden: () => projectResourceLocation("p", record) === null,
    repair: () => Boolean(projectResourceNeedsRepair("p", record)),
    place: (destination) =>
      apply(
        planResourceLocation({
          record,
          projectId: "p",
          intentId: `i${++sequence}`,
          eligibleAt: 1,
          destination,
        }),
      ),
    remove: () => apply(planResourceDeletion(record, "p", `i${++sequence}`)),
    remoteDelete: () =>
      apply({
        next: {
          ...record,
          resource: {
            ...committedResourceDeletion(record.resource, "9", "remote", "9"),
            revision: record.resource.revision + 1,
          },
        },
      }),
    prepare: () =>
      apply(
        prepareNamespaceAttempt(record, {
          attemptId: `a${++sequence}`,
          operationId: `o${sequence}`,
        }),
      ),
    resolve: (refused, receiptless) => {
      const intent = record.intents.find((i) => i.state === "submitted");
      if (!intent) return;
      const attempt = intent.attempts.at(-1)!;
      apply(
        recordNamespaceOutcome(
          record,
          intent.intentId,
          attempt.attemptId,
          evidence(attempt, refused, receiptless),
        ),
      );
      apply(settleNamespaceOutcome(record, 100));
    },
    refresh: () => {
      const barrier = record.resource.obligations.canonicalRefresh;
      if (barrier)
        apply(
          installCanonicalRefresh({
            observationVersion: "1",
            record,
            operationId: barrier.operationId,
            location: loc("B/doc.md"),
            parent: { kind: "folder", folderId: "B" },
          }),
        );
    },
  };
}
function folderMachine(): Machine {
  let record: FolderNamespaceRecord = {
    projectId: "p",
    handle: "A",
    folderId: "A",
    revision: 1,
    canonical: loc("P/A"),
    intents: [],
  };
  validateFolderNamespaceUpdate(null, record);
  let sequence = 0;
  const apply = (write: { next: FolderNamespaceRecord } | null) => {
    if (write) {
      validateFolderNamespaceUpdate(record, write.next);
      record = write.next;
    }
  };
  const context = () => ({
    record,
    projectId: "p",
    handle: "A",
    folderId: "A",
    source: record.canonical,
    intentId: `i${++sequence}`,
    operationId: `o${sequence}`,
  });
  return {
    intents: () => record.intents,
    terminal: () => Boolean(record.terminal),
    hidden: () =>
      !projectFolderCatalog("p", entries, [record]).some((entry) => entry.entryId === "A"),
    repair: () => Boolean(projectFolderNeedsRepair(record)),
    place: (destination) => apply(planFolderLocation({ ...context(), destination })),
    remove: () => apply(planFolderDeletion(context())),
    remoteDelete: () =>
      apply({ next: { ...record, revision: record.revision + 1, terminal: { generation: "9" } } }),
    prepare: () =>
      apply(
        prepareFolderNamespaceAttempt(record, {
          attemptId: `a${++sequence}`,
          operationId: `o${sequence}`,
        }),
      ),
    resolve: (refused, receiptless) => {
      const intent = record.intents.find((i) => i.state === "submitted");
      if (!intent) return;
      const attempt = intent.attempts.at(-1)!;
      apply(
        recordFolderNamespaceOutcome(
          record,
          intent.intentId,
          attempt.attemptId,
          evidence(attempt, refused, receiptless),
        ),
      );
      apply(settleFolderNamespaceOutcome(record, 100));
    },
    refresh: () => {
      if (record.canonicalRefresh)
        apply(
          installFolderCanonicalRefresh(
            record,
            record.canonicalRefresh.operationId,
            loc("B/A"),
            {
              kind: "folder",
              folderId: "B",
            },
            String(record.revision),
          ),
        );
    },
  };
}
const orders = permutations<Event>([
  "move",
  "rename",
  "delete",
  "refusal",
  "remote-delete",
  "catalog-refresh",
]);
it("validates and drains all 5,760 file/folder schedules", () => {
  const failures: {
    kind: string;
    receiptless: boolean;
    auto: boolean;
    order: Event[];
    at: string;
    error: string;
  }[] = [];
  let passed = 0;
  for (const kind of ["file", "folder"] as const)
    for (const receiptless of [true, false])
      for (const auto of [true, false])
        for (const order of orders) {
          const machine = kind === "file" ? fileMachine() : folderMachine();
          let admittedDelete = false,
            deleteResolved = false,
            at = "start";
          try {
            for (const event of order) {
              at = event;
              if (event === "remote-delete") machine.remoteDelete();
              else if (event === "refusal") machine.resolve(true, receiptless);
              else if (event === "catalog-refresh") machine.refresh();
              else if (!machine.terminal() && !machine.intents().some(intentOwnsDeletion)) {
                if (event === "delete") {
                  machine.remove();
                  admittedDelete = true;
                } else
                  machine.place({
                    parent: { kind: "folder", folderId: event === "move" ? "B" : "P" },
                    name: event === "rename" ? "Renamed" : "A",
                  });
              }
              if (auto) machine.prepare();
              if (
                admittedDelete &&
                machine
                  .intents()
                  .some(
                    (i) =>
                      i.desired.kind === "delete" &&
                      (i.state === "settled" || i.state === "needs-repair"),
                  )
              )
                deleteResolved = true;
              // Hidden means a live deletion, accepted deletion, or terminal identity; repairs cannot silently hide.
              assert(
                !machine.hidden() ||
                  machine.terminal() ||
                  machine.intents().some(intentOwnsDeletion),
              );
              if (machine.terminal()) assert(machine.hidden());
            }
            at = "drain";
            for (let step = 0; step < 8; step++) {
              machine.prepare();
              const active = activeNamespaceIntent({ intents: machine.intents() });
              if (active?.state !== "submitted") break;
              machine.resolve(active.desired.kind !== "delete", receiptless);
              machine.refresh();
            }
            assert(!activeNamespaceIntent({ intents: machine.intents() }) || machine.repair());
            if (admittedDelete && !deleteResolved)
              assert(
                machine
                  .intents()
                  .some(
                    (i) =>
                      i.desired.kind === "delete" &&
                      (i.state === "settled" ||
                        i.state === "needs-repair" ||
                        (machine.terminal() && i.state === "unexecutable-after-terminal")),
                  ),
              );
            if (machine.terminal()) assert(machine.hidden());
            passed++;
          } catch (error) {
            failures.push({ kind, receiptless, auto, order, at, error: String(error) });
          }
        }
  expect(failures).toEqual([]);
  expect(passed).toBe(5760);
});
