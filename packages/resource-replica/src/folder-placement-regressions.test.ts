/**
 * Tests folder placement regressions behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Bounded projection and canonical cycle repair
 */

import { execFile } from "node:child_process";
/**
 * Projection must remain bounded and preserve real recovery identities without catalogs.
 * The timing fence sits above a healthy run on a busy CI core. A depth-squared walk is seconds.
 */
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { installFolderNamespaceAvailability } from "./folder-namespace";
import { folderPlacementGraph } from "./folder-placement";
import { createResourcePlacement } from "./folder-projection";
import {
  del,
  entries,
  loc,
  move,
  node,
  outcome,
  permutations,
  submit,
} from "./namespace-schedule-fixtures";
import type { ResourceRecord } from "./resource-records";
import { untitledDestination } from "./resource-records";

const boundedMs = 500;

it("resolves 200 nested journal identities with a missing destination without a depth blowup", () => {
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
  expect(performance.now() - start).toBeLessThan(boundedMs);
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

it.each([
  [300, 1],
  [30, 20],
])("projects a healthy %i-deep catalog with %i branches without a depth blowup", (depth, width) => {
  const rows = [entries[0]];
  for (let branch = 0; branch < width; branch++) {
    rows.push(node(`${branch}-0`, `W${branch}`));
    for (let level = 1; level <= depth; level++)
      rows.push(
        node(
          `${branch}-${level}`,
          `W${branch}/${Array(level).fill("A").join("/")}`,
          `${branch}-${level - 1}`,
        ),
      );
  }
  const start = performance.now();
  const projected = createResourcePlacement("p", rows, []).projectCatalog(rows);
  const elapsed = performance.now() - start;
  expect(projected).toHaveLength(rows.length);
  expect(elapsed).toBeLessThan(boundedMs);
});

it("cycle fallback preserves an independently renamed canonical parent", () => {
  const folders = [
    outcome(submit(move("P", "P", "Q")), true),
    move("A", "P/A", "B/A"),
    move("B", "B", "P/A/B"),
  ];
  for (const records of permutations(folders)) {
    for (const catalog of [entries, [...entries].reverse()]) {
      const projected = createResourcePlacement("p", catalog, records).projectCatalog(catalog);
      expect(projected.find((row) => row.entryId === "P")).toMatchObject({ path: ["Q"] });
      expect(projected.find((row) => row.entryId === "A")).toMatchObject({
        parentId: "P",
        path: ["Q", "A"],
      });
      expect(projected.find((row) => row.entryId === "f")).toMatchObject({
        parentId: "A",
        path: ["Q", "A", "doc.md"],
      });
      expect(projected.some((row) => row.kind === "folder" && row.navigationOnly)).toBe(false);
    }
  }
});

it("does not synthesize navigation ancestors for a suppressed incomplete subtree", () => {
  const rows = [entries[0], node("P", "P"), node("A", "P/missing/A", "P")];
  const projected = createResourcePlacement("p", rows, [del("P", "P")]).projectCatalog(rows);
  expect(projected).toEqual([entries[0]]);
});

it("binds document observations to a parent's exact canonical home ahead of its checkpoint", () => {
  const record = move("B", "C", "D");
  const graph = folderPlacementGraph("p", [{ id: "B", canonical: loc("B") }], [record]);
  expect(
    graph.place(loc("C/doc.md"), undefined, { kind: "folder", folderId: "B" }).location,
  ).toMatchObject({
    path: "/D/doc.md",
    name: "doc.md",
  });
});

it("resolves 800 siblings under 800 missing levels without a depth blowup", () => {
  const prefix = Array(800).fill("missing").join("/");
  const nodes = Array.from({ length: 800 }, (_, i) => ({
    id: `s${i}`,
    canonical: loc(`${prefix}/s${i}`),
    parent: { kind: "folder" as const, folderId: "missing-parent" },
  }));
  const start = performance.now();
  const graph = folderPlacementGraph("p", nodes, []);
  expect(performance.now() - start).toBeLessThan(boundedMs);
  expect(graph.locations.get("s799")?.path).toBe(`/${prefix}/s799`);
});

it("retains exact-ID parent provenance after A is renamed and its old home is reused", () => {
  // Validated rename receipt followed by newer exact-ID evidence of the later move.
  const queued = outcome(submit(move("F", "A", "B")), true);
  const refreshed = installFolderNamespaceAvailability(
    queued,
    queued.canonicalRefresh!.operationId,
    {
      observationVersion: "1",
      kind: "available",
      location: loc("A/B"),
      parent: { kind: "folder", folderId: "new-A" },
    },
  )!.next;
  const stale = createResourcePlacement("p", [entries[0], node("F", "A")], [refreshed]);
  expect(stale.folderLocation("F")?.path).toBe("/A/B");
  const catalog = [entries[0], node("F", "A"), node("new-A", "A")];
  const placement = createResourcePlacement("p", catalog, [refreshed]);
  expect(placement.folderLocation("F")?.path).toBe("/A/B");
  expect(placement.parentForFolder("F")).toEqual({ kind: "folder", folderId: "new-A" });
});

it("roots a two-folder canonical cycle at each member's absolute observation", () => {
  const catalog = [entries[0], node("A", "old/A", "B"), node("B", "new/B", "A")];
  const placement = createResourcePlacement("p", catalog, []);
  expect(placement.folderLocation("A")?.path).toBe("/old/A");
  expect(placement.folderLocation("B")?.path).toBe("/new/B");
});

it("roots a self-parent canonical observation without attaching its old home", () => {
  const placement = createResourcePlacement("p", [entries[0], node("F", "old/F", "F")], []);
  expect(placement.folderLocation("F")?.path).toBe("/old/F");
  expect(placement.parentForFolder("F")?.kind).toBe("root");
});

it("parents a refused create by the folder that holds its shown location", () => {
  const create = (folderPath: string): ResourceRecord => ({
    resource: {
      handle: "r",
      revision: 1,
      identity: { documentId: "d", revision: 1 },
      content: { kind: "exact", databaseName: "c", schema: null },
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
      materialization: { kind: "untitled", folderPath, provisionalName: "Untitled" },
      canonical: null,
      serverHold: "local",
      lifecycle: { kind: "local" },
      aliases: {},
      obligations: { createEligibility: { eligibleAt: 1 } },
    },
    intents: [
      {
        projectId: "p",
        handle: "r",
        intentId: "i",
        sequence: 1,
        identityRevision: 1,
        desired: {
          kind: "set-location",
          typedName: "Untitled",
          destination: untitledDestination(folderPath, "Untitled"),
        },
        // A refused create owns no placement, so its shown location names its parent.
        attempts: [
          {
            attemptId: "attempt",
            request: { kind: "create", body: { documentId: "d", folderPath } },
            outcome: {
              kind: "refusal",
              operationId: "d",
              error: {
                code: "bad_request",
                message: "refused",
                retryable: false,
                source: "gateway",
              },
            },
          },
        ],
        state: "needs-repair",
      },
    ],
  });
  // Creates live in the unfiled area, so the holding folder does too.
  const unfiled = { ...entries[0], scheme: "unfiled", uri: "unfiled://" } as (typeof entries)[0];
  const folder = { ...node("F", "drafts"), uri: "unfiled://drafts" };
  const placement = createResourcePlacement("p", [unfiled, folder], []);
  expect(placement.parentForResource(create("drafts"))).toEqual({
    kind: "folder",
    folderId: "F",
  });
  expect(placement.parentForResource(create(""))).toMatchObject({ kind: "root" });
});
it("terminates and is order-independent for 1000 seeded random edge sets", async () => {
  // A process deadline can interrupt a synchronous graph loop; a test timer cannot.
  const script = `
    import assert from 'node:assert/strict';
    import { folderPlacementGraph } from ${JSON.stringify(new URL("./folder-placement.ts", import.meta.url).href)};
    import { planFolderLocation } from ${JSON.stringify(new URL("./folder-namespace.ts", import.meta.url).href)};
    let seed = 754;
    const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const root = { kind: 'root', scheme: 'manuscript', owner: { workId: null } };
    let checked = 0;
    for (let trial = 0; trial < 1000; trial++) {
      const size = 1 + random(40);
      const parent = () => random(5) === 0 ? root : { kind: 'folder', folderId: String(random(size + 2)) };
      const nodes = Array.from({ length: size }, (_, i) => ({
        id: String(i), parent: parent(),
        canonical: { scheme: 'manuscript', workId: null, path: '/old/' + i, name: String(i) },
      }));
      const records = nodes.filter(() => random(2) === 0).map((node) => {
        const record = planFolderLocation({ projectId: 'p', handle: node.id, folderId: node.id,
          source: node.canonical, sourceParent: node.parent, intentId: 'i' + node.id,
          operationId: 'o' + node.id, destination: { parent: root, name: 'new' + node.id },
        }).next;
        record.intents[0].desired.destination.parent = parent();
        return record;
      });
      const graph = folderPlacementGraph('p', nodes, records);
      const reverse = folderPlacementGraph('p', [...nodes].reverse(), [...records].reverse());
      for (const node of nodes) {
        assert.deepEqual(graph.locations.get(node.id), reverse.locations.get(node.id));
        const visited = new Set();
        let id = node.id;
        while (id !== undefined) {
          assert(!visited.has(id), 'final parent cycle');
          visited.add(id);
          const edge = graph.parentForFolder(id);
          id = edge?.kind === 'folder' ? edge.folderId : undefined;
        }
        assert(graph.locations.get(node.id));
        checked++;
      }
    }
    console.log(checked);
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      timeout: 10_000,
    },
  );
  expect(Number(stdout.trim())).toBeGreaterThan(1000);
}, 15_000);
