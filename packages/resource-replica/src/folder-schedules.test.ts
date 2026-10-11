import assert from "node:assert/strict";
import type { CatalogEntry } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { catalogViewFromSnapshot } from "./catalog";
import {
  folderObservationFence,
  planFolderCatalogInstallation,
} from "./folder-catalog-installation";
import { folderOwnsDeletion, validateFolderNamespaceUpdate } from "./folder-namespace";
import { projectFolderCatalog } from "./folder-projection";
import {
  del,
  entries,
  move,
  outcome,
  permutations,
  scope,
  submit,
} from "./namespace-schedule-fixtures";
import type { FolderNamespaceRecord } from "./resource-records";

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
    let es: CatalogEntry[] = structuredClone([...entries]);
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
        if (![...rs.values()].some(folderOwnsDeletion)) assert.equal(view.length, es.length);
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
});
