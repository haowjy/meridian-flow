/**
 * Probe: a Yjs snapshot (a frontier) survives the branch store's compaction fold while the
 * origin stays `gc: false`. Pure Yjs, no database: `pnpm exec tsx tools/qa/probes/frontier-survives-compaction/run.mts`.
 * Prints each observation and exits with the number of failed checks.
 */
import * as Y from "yjs";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed += 1;
}

const text = (doc: Y.Doc) => doc.getXmlFragment("content").toString();
const fresh = (gc: boolean) => new Y.Doc({ gc });
/** The same containment the design asks of a room: every client of the snapshot is present, no behind. */
function originContainsSnapshot(origin: Y.Doc, snapshot: Y.Snapshot): boolean {
  const sv = Y.decodeStateVector(Y.encodeStateVector(origin));
  for (const [client, clock] of snapshot.sv)
    if (clock > 0 && (sv.get(client) ?? 0) < clock) return false;
  return true;
}
function frames(doc: Y.Doc, from: number, to: number): void {
  const fragment = doc.getXmlFragment("content");
  for (let i = from; i < to; i += 1) {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(`frame ${i} `.repeat(10))]);
    fragment.insert(fragment.length, [paragraph]);
    if (i % 3 === 0 && fragment.length > 2) fragment.delete(1, 1);
  }
}

// 1. The frontier survives a fold. A is the room (gc off); S is taken mid-history, with deletes.
const A = fresh(false);
frames(A, 0, 200);
const S = Y.snapshot(A);
const atS = fresh(false);
Y.applyUpdate(atS, Y.encodeStateAsUpdate(A));
frames(A, 200, 800);
const fold = Y.encodeStateAsUpdate(A); // the compaction fold of a gc-off doc
const B = fresh(false); // checkpoint + tail, as a materialization loads it
Y.applyUpdate(B, fold);
check(
  "snapshot restores from the folded origin",
  text(Y.createDocFromSnapshot(B, S, fresh(false))) === text(atS),
  `snapshot ${Y.encodeSnapshotV2(S).length} bytes, fold ${fold.length} bytes`,
);

// 2. A gc-on origin throws; a once-collected store restores the wrong text without throwing.
const G = fresh(true);
Y.applyUpdate(G, fold);
let threw = "";
try {
  Y.createDocFromSnapshot(G, S);
} catch (cause) {
  threw = (cause as Error).message;
}
check("a gc-on origin throws", threw.includes("Garbage-collection must be disabled"), threw);
const leaked = fresh(false);
Y.applyUpdate(leaked, Y.encodeStateAsUpdate(G));
check(
  "a once-collected store restores wrong text silently",
  text(Y.createDocFromSnapshot(leaked, S, fresh(false))) !== text(atS),
);

// 3. Containment accepts the compacted room and refuses a re-fork with the same visible text.
const refork = fresh(false);
refork.getXmlFragment("content").insert(0, [new Y.XmlText(text(atS))]);
check("containment accepts the compacted room", originContainsSnapshot(B, S));
check("containment refuses a re-fork", !originContainsSnapshot(refork, S));

process.exit(failed);
