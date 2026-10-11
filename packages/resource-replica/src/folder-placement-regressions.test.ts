/** Projection must remain bounded and preserve real recovery identities without catalogs. */
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { installFolderNamespaceAvailability } from "./folder-namespace";
import { folderPlacementGraph } from "./folder-placement";
import { createResourcePlacement } from "./folder-projection";
import { del, loc, move, outcome, submit } from "./namespace-schedule-fixtures";

it("resolves 200 nested journal identities with a missing destination in under 100 ms", () => {
  const nodes = [];
  const records = [];
  for (let depth = 1; depth <= 200; depth++) {
    const path = Array(depth).fill("A").join("/");
    nodes.push({ id: `a${depth}`, canonical: loc(path) });
    records.push(move(`a${depth}`, path, `${path}2`));
  }
  nodes.push({ id: "X", canonical: loc("X") });
  records.push(move("X", "X", `${Array(200).fill("A").join("/")}/absent/X`));
  const start = performance.now();
  const graph = folderPlacementGraph("p", nodes, records);
  expect(performance.now() - start).toBeLessThan(100);
  expect(graph.locations.get("X")).toMatchObject({ path: "/X" });
});

it("installs real repair parents before synthesizing missing ancestry in either ID order", () => {
  const unavailable = (id: string, path: string, to: string) => {
    const queued = del(id, path, outcome(submit(move(id, path, to)), true));
    return installFolderNamespaceAvailability(queued, queued.canonicalRefresh!.operationId, {
      kind: "unavailable",
    })!.next;
  };
  for (const [parent, child] of [
    ["z-parent", "a-child"],
    ["a-parent", "z-child"],
  ]) {
    const folders = [unavailable(child, "P/A", "B/A"), unavailable(parent, "P", "Q")];
    for (const records of [folders, [...folders].reverse()]) {
      const rows = createResourcePlacement("p", [], records).projectCatalog([]);
      expect(
        rows.filter((row) => row.kind === "folder" && row.path.join("/") === "P"),
      ).toMatchObject([{ entryId: parent }]);
      expect(rows.find((row) => row.entryId === child)).toMatchObject({ parentId: parent });
    }
  }
});
