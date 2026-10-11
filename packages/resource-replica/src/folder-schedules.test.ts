import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { folderOwnsDeletion, validateFolderNamespaceUpdate } from "./folder-namespace";
import { projectFolderCatalog } from "./folder-projection";
import { del, entries, move, outcome, submit } from "./namespace-schedule-fixtures";

function perms(a: string[]): string[][] {
  return a.length
    ? a.flatMap((x, i) => perms(a.filter((_, j) => i !== j)).map((p) => [x, ...p]))
    : [[]];
}
it("projects every nested placement/deletion schedule", () => {
  const failures: any[] = [];
  let passed = 0,
    _projections = 0;
  for (const childAction of ["move", "rename"])
    for (const deleted of ["A", "P", "B"])
      for (const refused of ["A", "P"])
        for (const remote of ["A", "P", "B"])
          for (const order of perms(["child", "parent", "delete", "refusal", "remote-delete"])) {
            let es: any[] = structuredClone(entries);
            const rs = new Map<string, any>();
            const history: string[] = [];
            const project = () => {
              _projections++;
              return projectFolderCatalog("p", es, [...rs.values()]);
            };
            const save = (id: string, r: any) => {
              validateFolderNamespaceUpdate(rs.get(id) ?? null, r);
              rs.set(id, r);
            };
            try {
              for (const event of order) {
                history.push(event);
                if (event === "remote-delete") {
                  const e = es.find((e) => e.entryId === remote);
                  if (e)
                    es = es.filter(
                      (x) =>
                        x.kind === "source" ||
                        !(
                          x.path.join("/") === e.path.join("/") ||
                          x.path.join("/").startsWith(`${e.path.join("/")}/`)
                        ),
                    );
                } else if (event === "refusal") {
                  if (rs.get(refused)?.intents.some((i: any) => i.state === "submitted"))
                    rs.set(refused, outcome(rs.get(refused)));
                } else {
                  const id = event === "child" ? "A" : event === "parent" ? "P" : deleted;
                  const current = project().find((e) => e.entryId === id);
                  const canonical = es.find((e) => e.entryId === id);
                  if (
                    !current ||
                    (current.kind !== "folder" && current.kind !== "file") ||
                    !canonical
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
                    const r = submit(rs.get(id));
                    save(id, r);
                  }
                }
                const view = project();
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
  expect(passed).toBe(4320);
});
