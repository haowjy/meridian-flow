import assert from "node:assert/strict";
import type { CatalogEntry } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { catalogViewFromSnapshot } from "./catalog";
import {
  folderObservationFence,
  planFolderCatalogInstallation,
} from "./folder-catalog-installation";
import {
  folderOwnsDeletion,
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
import {
  del,
  entries,
  evidence,
  loc,
  move,
  outcome,
  permutations,
  scope,
  submit,
} from "./namespace-schedule-fixtures";
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

type Event = "child" | "parent" | "delete" | "refusal" | "remote-delete" | "catalog-refresh";
type Scenario = {
  childAction: string;
  deleted: string;
  refused: string;
  remote: string;
  order: Event[];
};
const scenarios: Scenario[] = [];
for (const childAction of ["move", "rename"])
  for (const deleted of ["A", "P", "B"])
    for (const refused of ["A", "P"])
      for (const remote of ["A", "P", "B"])
        for (const order of permutations<Event>([
          "child",
          "parent",
          "delete",
          "refusal",
          "remote-delete",
        ]))
          scenarios.push({ childAction, deleted, refused, remote, order });
// Keep every original reviewer ordering, then exhaustively insert catalog refresh for
// parent refusals with a disappearing move destination. No random schedule sampling.
for (const childAction of ["move", "rename"])
  for (const order of permutations<Event>([
    "child",
    "parent",
    "delete",
    "refusal",
    "remote-delete",
    "catalog-refresh",
  ]))
    scenarios.push({ childAction, deleted: "B", refused: "P", remote: "B", order });
it("projects every nested placement/deletion schedule", () => {
  const failures: {
    childAction: string;
    deleted: string;
    refused: string;
    remote: string;
    order: string[];
    history: string[];
    error: string;
  }[] = [];
  let passed = 0;
  for (const { childAction, deleted, refused, remote, order } of scenarios) {
    let es: CatalogEntry[] = [...entries];
    const rs = new Map<string, FolderNamespaceRecord>();
    const history: string[] = [];
    const project = () => {
      return projectFolderCatalog("p", es, [...rs.values()]);
    };
    const save = (id: string, r: FolderNamespaceRecord) => {
      validateFolderNamespaceUpdate(rs.get(id) ?? null, r);
      rs.set(id, r);
    };
    try {
      for (const event of order) {
        history.push(event);
        if (event === "remote-delete") {
          const e = es.find((e) => e.entryId === remote);
          if (e && (e.kind === "folder" || e.kind === "file"))
            es = es.filter(
              (x) =>
                (x.kind !== "file" && x.kind !== "folder") ||
                !(
                  x.path.join("/") === e.path.join("/") ||
                  x.path.join("/").startsWith(`${e.path.join("/")}/`)
                ),
            );
        } else if (event === "catalog-refresh") {
          const view = catalogViewFromSnapshot({
            scope,
            generation: "g",
            headRevision: "2",
            cursor: "c",
            entries: es,
          });
          for (const write of planFolderCatalogInstallation({
            projectId: "p",
            folders: [...rs.values()],
            view,
            fence: { folders: folderObservationFence([...rs.values()]) },
          }))
            save(write.next.folderId, write.next);
        } else if (event === "refusal") {
          if (rs.get(refused)?.intents.some((i) => i.state === "submitted"))
            rs.set(refused, outcome(rs.get(refused)!));
        } else {
          const id = event === "child" ? "A" : event === "parent" ? "P" : deleted;
          const current = project().find((e) => e.entryId === id);
          const canonical = es.find((e) => e.entryId === id);
          if (
            !current ||
            (current.kind !== "folder" && current.kind !== "file") ||
            !canonical ||
            canonical.kind !== "folder"
          )
            continue;
          if (event === "delete") save(id, del(id, canonical.path.join("/"), rs.get(id)));
          else {
            if (
              event === "child" &&
              childAction === "move" &&
              !project().some((e) => e.entryId === "B")
            )
              continue;
            const destination =
              event === "parent"
                ? "Q"
                : childAction === "move"
                  ? "B/A"
                  : [...current.path.slice(0, -1), "Renamed"].join("/");
            save(id, move(id, canonical.path.join("/"), destination, rs.get(id)));
            const r = submit(rs.get(id)!);
            save(id, r);
          }
        }
        const view = project();
        const reordered = projectFolderCatalog("p", es, [...rs.values()].reverse());
        assert.deepEqual(reordered, view);
        if (![...rs.values()].some(folderOwnsDeletion)) {
          // The checkpoint retains every ordinary row. Missing repair identities and
          // their ancestor chain are additional journal-owned recovery rows.
          const installed = new Set(es.map((entry) => entry.entryId));
          assert.equal(view.filter((entry) => installed.has(entry.entryId)).length, es.length);
          const recovery = new Set<string>();
          for (const record of rs.values()) {
            if (!record.intents.some((intent) => intent.state === "needs-repair")) continue;
            let entry = view.find((entry) => entry.entryId === record.folderId);
            while (entry && !recovery.has(entry.entryId)) {
              recovery.add(entry.entryId);
              const parentId =
                entry.kind === "folder" || entry.kind === "file" ? entry.parentId : null;
              entry = view.find((parent) => parent.entryId === parentId);
            }
          }
          for (const entry of view)
            assert(installed.has(entry.entryId) || recovery.has(entry.entryId));
        }
        for (const [id, r] of rs)
          if (folderOwnsDeletion(r)) assert(!view.some((e) => e.entryId === id));
      }
      passed++;
    } catch (e) {
      failures.push({
        childAction,
        deleted,
        refused,
        remote,
        order,
        history,
        error: String(e),
      });
    }
  }
  expect(failures).toEqual([]);
  expect(passed).toBe(5760);
}, 30_000);

{
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
        serverHold: "held",
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
      serverHold: "held",
      observationVersion: "0",
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
      source: record.canonical ?? undefined,
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
        apply({
          next: { ...record, revision: record.revision + 1, terminal: { generation: "9" } },
        }),
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
                const active = activeNamespaceIntent({
                  intents: machine.intents(),
                });
                if (active?.state !== "submitted") break;
                machine.resolve(active.desired.kind !== "delete", receiptless);
                machine.refresh();
              }
              assert(
                !activeNamespaceIntent({
                  intents: machine.intents(),
                }) || machine.repair(),
              );
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
}
