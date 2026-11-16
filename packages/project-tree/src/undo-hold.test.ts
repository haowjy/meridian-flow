/**
 * An Undo estimate holds a record only for a source it changes itself: a held record is out of
 * the replay the records after it (in the order the Undo takes them) are read from, and a held
 * Undo writes nothing to the list.
 */

import { expect, it } from "vitest";
import * as Y from "yjs";
import { LIVE, TreeWriter, undoChange, undoReports } from "./index.js";

const closed = (s: string) => s === "B";
function setup() {
  const doc = new Y.Doc({ gc: false });
  const w = new TreeWriter(doc);
  const P = w.create(LIVE, "system", { parent: "source:B", name: "P", kind: "folder" });
  const X = w.create(LIVE, "system", { parent: P.node, name: "X", kind: "folder" });
  return { doc, w, P, X };
}
const inLive = (...ids: string[]) => ids.map((id) => ({ id, view: LIVE }));
it("independent: held parent move, child rename in the same moved folder", () => {
  const { w, P, X } = setup();
  const r1 = w.rename(LIVE, "system", X.node, "Y");
  const r2 = w.move(LIVE, "system", P.node, "source:A");
  const before = Y.encodeStateVector(w.doc);
  const reports = undoReports(w, inLive(r2.id, r1.id), closed);
  expect(reports.get(r1.id)?.sources.some(closed)).toBe(false);
  expect(reports.get(r2.id)?.sources.some(closed)).toBe(true);
  // the press, record by record
  expect(undoChange(w, LIVE, "system", r2.id, closed)).toEqual({ closed: "B" });
  const back = undoChange(w, LIVE, "system", r1.id, closed);
  expect(typeof back).toBe("object");
  expect("closed" in (back as object)).toBe(false);
  const diff = Y.encodeStateAsUpdate(w.doc, before);
  expect(Y.decodeUpdate(diff).ds.clients.size).toBe(0);
  expect(Y.decodeUpdate(diff).structs.length).toBe(1);
});
it("dependent: child's way back goes into the parent, which stays out", () => {
  const { w, P, X } = setup();
  const r1 = w.move(LIVE, "system", X.node, "source:A");
  const r2 = w.move(LIVE, "system", P.node, "source:A");
  const reports = undoReports(w, inLive(r2.id, r1.id), closed);
  expect(reports.get(r2.id)?.sources.some(closed)).toBe(true);
  expect(reports.get(r1.id)?.sources.some(closed)).toBe(false);
  // without `closed` the batch reads the child through the parent's return: B
  const naive = undoReports(w, inLive(r2.id, r1.id));
  expect(naive.get(r1.id)?.sources.some(closed)).toBe(true);
  expect(undoChange(w, LIVE, "system", r2.id, closed)).toEqual({ closed: "B" });
  const back = undoChange(w, LIVE, "system", r1.id, closed);
  expect("closed" in (back as object)).toBe(false);
});
