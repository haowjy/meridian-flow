/** Adversarial identity graphs must terminate independently of server observation coherence. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

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
    { timeout: 10_000 },
  );
  expect(Number(stdout.trim())).toBeGreaterThan(1000);
}, 15_000);
