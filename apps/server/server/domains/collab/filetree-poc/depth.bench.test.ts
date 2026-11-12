/** Proof code. The derive half of a replay against how deep the folders nest, nodes held fixed. */
import { it } from "vitest";
import { replay, ROOT, type TreeOp } from "./tree-log.js";

it("derive cost by depth at 22,000 nodes", () => {
  const lines: string[] = [];
  for (const depth of [3, 10, 50, 200]) {
    const ops: TreeOp[] = [];
    const chain = [ROOT];
    for (let d = 0; d < depth; d += 1) {
      ops.push({ id: `f${d}`, actor: "u", draft: null, type: "create", node: `f${d}`, kind: "folder", name: `F${d}`, parent: chain[d] as string, rank: "a" });
      chain.push(`f${d}`);
    }
    for (let i = 0; ops.length < 22_000; i += 1)
      ops.push({ id: `c${i}`, actor: "u", draft: null, type: "create", node: `c${i}`, kind: "document", name: `C${i}`, parent: chain[1 + (i % depth)] as string, rank: `a${i.toString(36).padStart(6, "0")}` });
    const derive: number[] = [];
    const through: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const timing = { records: 0, derive: 0 };
      replay(ops, { timing });
      derive.push(timing.derive);
      through.push(timing.records);
    }
    derive.sort((a, b) => a - b);
    through.sort((a, b) => a - b);
    lines.push(`depth ${depth}, ${Math.round(22_000 / depth)} documents a folder: records ${through[4]?.toFixed(1)} ms, derive ${derive[4]?.toFixed(1)} ms`);
  }
  console.info(`derive by depth\n${lines.join("\n")}`);
}, 300_000);
