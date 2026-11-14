import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { splitSyncFrame, splitUpdate } from "./parts.js";

const records = (doc: Y.Doc) => doc.getArray<{ n: number }>("ops");
const push = (doc: Y.Doc, from: number, to: number) => {
  for (let n = from; n < to; n++) records(doc).push([{ n }]);
};

describe("splitUpdate", () => {
  it("cuts one merged run and two interleaved clients into parts that apply in order", () => {
    const a = new Y.Doc({ gc: false });
    a.clientID = 1001;
    const b = new Y.Doc({ gc: false });
    b.clientID = 1002;
    push(a, 0, 700);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    push(b, 1000, 1500);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    push(a, 2000, 2300);

    const server = new Y.Doc({ gc: false });
    const parts = splitUpdate(Y.encodeStateAsUpdate(a), 200);
    expect(parts.length).toBeGreaterThanOrEqual(8);
    for (const part of parts) {
      const size = Y.decodeUpdate(part).structs.reduce((n, s) => n + s.length, 0);
      expect(size).toBeLessThanOrEqual(200);
      Y.applyUpdate(server, part);
      expect(server.store.pendingStructs).toBeNull();
    }
    expect(records(server).toJSON()).toEqual(records(a).toJSON());
  });

  it("leaves an update with a deletion whole", () => {
    const doc = new Y.Doc({ gc: false });
    push(doc, 0, 50);
    records(doc).delete(3);
    const update = Y.encodeStateAsUpdate(doc);
    expect(splitUpdate(update, 10)).toEqual([update]);
  });
});

describe("splitSyncFrame", () => {
  it("leaves small frames alone", () => {
    const frame = new Uint8Array([1, 2, 3]);
    expect(splitSyncFrame(frame, 10)).toEqual([frame]);
  });
});
