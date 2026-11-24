import { LoroDoc } from "loro-crdt";
import { expect, it } from "vitest";
import { LIVE, TreeWriter, undoChange, undoReports } from "./index.js";

const closed = (s: string) => s === "B";
function setup() {
  const doc = new LoroDoc();
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
  const appended = () => w.doc.getList("ops").length + w.doc.getList("settle").length;
  const before = appended();
  const reports = undoReports(w, inLive(r2.id, r1.id), closed);
  expect(reports.get(r1.id)?.sources.some(closed)).toBe(false);
  expect(reports.get(r2.id)?.sources.some(closed)).toBe(true);
  expect(undoChange(w, LIVE, "system", r2.id, closed)).toEqual({ closed: "B" });
  const back = undoChange(w, LIVE, "system", r1.id, closed);
  expect(typeof back).toBe("object");
  expect("closed" in (back as object)).toBe(false);
  expect(appended() - before).toBe(1);
});
it("dependent: child's way back goes into the parent, which stays out", () => {
  const { w, P, X } = setup();
  const r1 = w.move(LIVE, "system", X.node, "source:A");
  const r2 = w.move(LIVE, "system", P.node, "source:A");
  const reports = undoReports(w, inLive(r2.id, r1.id), closed);
  expect(reports.get(r2.id)?.sources.some(closed)).toBe(true);
  expect(reports.get(r1.id)?.sources.some(closed)).toBe(false);
  const naive = undoReports(w, inLive(r2.id, r1.id));
  expect(naive.get(r1.id)?.sources.some(closed)).toBe(true);
  expect(undoChange(w, LIVE, "system", r2.id, closed)).toEqual({ closed: "B" });
  const back = undoChange(w, LIVE, "system", r1.id, closed);
  expect("closed" in (back as object)).toBe(false);
});
