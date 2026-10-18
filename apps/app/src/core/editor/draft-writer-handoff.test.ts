/** Writer delivery across real session retirement, sync and acknowledgement boundaries. */
import { draftRoomName } from "@meridian/contracts/protocol";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { HttpResponseError } from "@/client/api/http-client";
import { draftHandoffHarness } from "@/test-support/draft-handoff-harness";

let runtime: ReturnType<typeof draftHandoffHarness>;
const room = (generation: number) => draftRoomName("handoff", generation);
const flush = () => vi.advanceTimersByTimeAsync(0);
function start() {
  vi.useFakeTimers();
  runtime = draftHandoffHarness();
  runtime.pool.retain("editor", [runtime.ref(room(1))]);
  runtime.pool.retain("refresh", [runtime.ref(room(1))]);
  const source = runtime.pool.get(room(1));
  const base = new Y.Doc({ gc: false });
  base.getText("text").insert(0, "hello");
  const baseline = Y.encodeStateAsUpdate(base);
  base.destroy();
  runtime.wire(room(1)).sync(baseline);
  runtime.wire(room(1)).ack();
  source.document.getText("text").insert(5, " WORLD");
  runtime.locate(async () => room(2));
  return { source, baseline };
}
function reset(generation: number, rebuild = false) {
  runtime.wire(room(generation)).emit({
    kind: "reset",
    reason: rebuild ? "draft-stale-doc" : "draft-generation-stale",
    disposition: rebuild ? "rebuild" : "superseded",
  });
}
async function delivered(generation: number, expected: string, baseline: Uint8Array) {
  await flush();
  const wire = runtime.wire(room(generation));
  wire.sync(baseline);
  await flush();
  const session = runtime.pool.peek(room(generation));
  if (!session) throw new Error("No successor session");
  expect(session.document.getText("text").toString()).toBe(expected);
  expect(session.document.store.pendingStructs).toBeNull();
  expect(session.document.store.pendingDs).toBeNull();
  const server = new Y.Doc({ gc: false });
  Y.applyUpdate(server, baseline);
  for (const update of wire.sent) Y.applyUpdate(server, update);
  expect(server.getText("text").toString()).toBe(expected);
  expect(server.store.pendingStructs).toBeNull();
  server.destroy();
  // The read before admission cannot publish a recovered draft. Only acknowledgement does.
  expect(runtime.changed).not.toHaveBeenCalled();
  wire.ack();
  await vi.advanceTimersByTimeAsync(10);
  expect(runtime.changed).toHaveBeenCalledTimes(1);
  expect(runtime.pool.peek(room(generation))).toBeUndefined();
}
afterEach(async () => {
  await runtime?.dispose();
  vi.useRealTimers();
});

it.each([
  "signal",
  "list first",
  "same room",
])("delivers surviving typing after %s with both owners and no mounted review", async (mode) => {
  const { source, baseline } = start();
  await flush();
  const target = mode === "same room" ? 1 : 2;
  runtime.locate(async () => room(target));
  if (mode === "list first") {
    runtime.pool.retain("editor", [runtime.ref(room(2))]);
    runtime.pool.retain("refresh", [runtime.ref(room(2))]);
    await vi.advanceTimersByTimeAsync(10);
    expect(runtime.pool.peek(room(1))).toBe(source);
  }
  reset(1, mode === "same room");
  runtime.pool.release("editor");
  runtime.pool.release("refresh");
  await delivered(target, "hello WORLD", baseline);
  expect(source.document.isDestroyed).toBe(true);
  expect(runtime.pool.peek(room(1))).toBeUndefined();
});

it("abandons an unsynced successor, then carries a replay overtaken by its acknowledgement to G+3", async () => {
  const { baseline } = start();
  await flush();
  reset(1);
  await flush();
  runtime.locate(async () => room(3));
  reset(2);
  await vi.advanceTimersByTimeAsync(10);
  expect(runtime.wire(room(2)).sent).toEqual([]);
  expect(runtime.wire(room(2)).document.getText("text").toString()).toBe("");
  expect(runtime.wire(room(2)).document.store.pendingStructs).toBeNull();
  runtime.wire(room(3)).sync(baseline);
  await flush();
  expect(runtime.wire(room(3)).document.getText("text").toString()).toBe("hello WORLD");
  runtime.locate(async () => room(4));
  reset(3);
  await flush();
  runtime.pool.release("editor");
  runtime.pool.release("refresh");
  await delivered(4, "hello WORLD", baseline);
});

it("account close fences both a pending locate and a pending first sync without retaining late results", async () => {
  for (const stage of ["locate", "sync"]) {
    const { baseline } = start();
    await flush();
    let locate!: (value: string) => void;
    if (stage === "locate")
      runtime.locate(
        () =>
          new Promise((resolve) => {
            locate = resolve;
          }),
      );
    reset(1);
    await flush();
    runtime.epoch.abort();
    runtime.pool.release("editor");
    runtime.pool.release("refresh");
    if (stage === "locate") locate(room(2));
    else runtime.wire(room(2)).sync(baseline);
    await vi.advanceTimersByTimeAsync(10);
    const successor = runtime.wires.get(room(2))?.at(-1);
    expect(successor?.document.getText("text").toString() ?? "").toBe(
      stage === "sync" ? "hello" : "",
    );
    expect(successor?.sent ?? []).toEqual([]);
    expect(successor?.document.store.pendingStructs ?? null).toBeNull();
    expect(runtime.pool.peek(room(2))).toBeUndefined();
    expect(runtime.changed).not.toHaveBeenCalled();
    await runtime.dispose();
  }
});

it.each([
  "read",
  "404",
  "403",
  "unauthorized",
])("settles %s without replay or retry", async (refusal) => {
  const { baseline } = start();
  await flush();
  const locate = vi.fn(async () => {
    if (refusal === "404" || refusal === "403")
      throw new HttpResponseError("route error", Number(refusal), {});
    return room(2);
  });
  runtime.locate(locate);
  reset(1);
  await flush();
  const wire = runtime.wires.get(room(2))?.at(-1);
  if (wire) {
    if (refusal === "read") wire.sync(baseline, "read");
    else wire.emit({ kind: "unauthorized", reason: "denied" });
  }
  runtime.pool.release("editor");
  runtime.pool.release("refresh");
  await vi.advanceTimersByTimeAsync(100);
  expect(locate).toHaveBeenCalledTimes(1);
  expect(wire?.document.getText("text").toString() ?? "").toBe(refusal === "read" ? "hello" : "");
  expect(wire?.sent ?? []).toEqual([]);
  expect(wire?.document.store.pendingStructs ?? null).toBeNull();
  expect(runtime.pool.peek(room(2))).toBeUndefined();
  expect(runtime.changed).not.toHaveBeenCalled();
});

it.each([
  false,
  true,
])("retains an unresolved carry (partial integration: %s) until its anchors arrive", async (partial) => {
  const { source } = start();
  const acknowledged = Y.encodeStateAsUpdate(source.document);
  // Give this writer an omitted AI anchor, then a later independent stroke on
  // the same client. Yjs cannot integrate that later clock without the first.
  runtime.wire(room(1)).ack();
  const omitted = new Y.Doc({ gc: false });
  Y.applyUpdate(omitted, Y.encodeStateAsUpdate(source.document));
  omitted.clientID = 5001;
  omitted.getText("text").insert(2, "gold");
  const dependency = Y.encodeStateAsUpdate(omitted);
  Y.applyUpdate(source.document, dependency, runtime.wire(room(1)));
  if (partial) source.document.getText("text").insert(0, "P");
  source.document.getText("text").insert(partial ? 5 : 4, "X");
  source.document.getText("text").insert(source.document.getText("text").length, "!");
  const expected = source.document.getText("text").toString();
  await flush();
  runtime.locate(async () => room(1));
  reset(1, true);
  await flush();
  // The successor knows all acknowledged writer clocks, but not the AI copy.
  const wire = runtime.wire(room(1));
  wire.sync(acknowledged);
  await flush();
  wire.ack();
  await vi.advanceTimersByTimeAsync(10);
  expect(runtime.changed).not.toHaveBeenCalled();
  expect(runtime.pool.peek(room(1))).toBeDefined();
  expect(runtime.writerChanges).toHaveBeenLastCalledWith(1);
  expect(wire.document.getText("text").toString()).not.toContain("!");
  wire.sync(dependency);
  await vi.advanceTimersByTimeAsync(10);
  expect(wire.document.getText("text").toString()).toBe(expected);
  expect(wire.document.store.pendingStructs).toBeNull();
  wire.ack();
  await flush();
  expect(runtime.changed).toHaveBeenCalledTimes(1);
  expect(runtime.writerChanges).toHaveBeenLastCalledWith(null);
  expect(runtime.writerLoss).not.toHaveBeenCalled();
  omitted.destroy();
});

it("settles a retired generation's permanently lost typing without a rescuable tail", async () => {
  const { source } = start();
  runtime.wire(room(1)).ack();
  const acknowledged = Y.encodeStateAsUpdate(source.document);
  const discarded = new Y.Doc({ gc: false });
  Y.applyUpdate(discarded, acknowledged);
  discarded.clientID = 5001;
  discarded.getText("text").insert(2, "gold");
  Y.applyUpdate(source.document, Y.encodeStateAsUpdate(discarded), runtime.wire(room(1)));
  source.document.getText("text").insert(4, "X");
  await flush();
  reset(1);
  await flush();
  const wire = runtime.wire(room(2));
  wire.sync(acknowledged);
  await flush();
  expect(wire.document.getText("text").toString()).toBe("hello WORLD");
  expect(runtime.writerLoss).toHaveBeenCalledTimes(1);
  expect(runtime.writerChanges).toHaveBeenLastCalledWith(null);
  runtime.pool.release("editor");
  runtime.pool.release("refresh");
  await vi.advanceTimersByTimeAsync(100);
  expect(runtime.pool.peek(room(2))).toBeUndefined();
  expect(runtime.writerLoss).toHaveBeenCalledTimes(1);
  const server = new Y.Doc({ gc: false });
  Y.applyUpdate(server, acknowledged);
  for (const update of wire.sent) Y.applyUpdate(server, update);
  expect(server.getText("text").toString()).toBe("hello WORLD");
  expect(server.store.pendingStructs).toBeNull();
  discarded.destroy();
  server.destroy();
});

it("rescues a writer-created rich container without copying its discarded AI dependency", async () => {
  const { source } = start();
  runtime.wire(room(1)).ack();
  const acknowledged = Y.encodeStateAsUpdate(source.document);
  const discarded = new Y.Doc({ gc: false });
  Y.applyUpdate(discarded, acknowledged);
  discarded.getText("text").insert(2, "gold");
  Y.applyUpdate(source.document, Y.encodeStateAsUpdate(discarded), runtime.wire(room(1)));
  source.document.getText("text").insert(4, "X");
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  text.insert(0, "note!!");
  text.format(0, 4, { bold: true });
  paragraph.setAttribute("align", "right");
  source.document.getXmlFragment("prosemirror").insert(0, [paragraph]);
  text.delete(4, 1);
  await flush();
  reset(1);
  await flush();
  const wire = runtime.wire(room(2));
  wire.sync(acknowledged);
  await flush();
  const expected = '<paragraph align="right"><bold>note</bold>!</paragraph>';
  expect(wire.document.getXmlFragment("prosemirror").toString()).toBe(expected);
  expect(wire.document.getText("text").toString()).toBe("hello WORLD");
  expect(runtime.writerLoss).toHaveBeenCalledTimes(1);
  wire.ack();
  await flush();
  const server = new Y.Doc({ gc: false });
  Y.applyUpdate(server, acknowledged);
  for (const update of wire.sent) Y.applyUpdate(server, update);
  expect(server.getXmlFragment("prosemirror").toString()).toBe(expected);
  expect(server.store.pendingStructs).toBeNull();
  expect(runtime.writerChanges).toHaveBeenLastCalledWith(null);
  discarded.destroy();
  server.destroy();
});

it("a selective Discard re-fork keeps anchored unsent typing and notices typing inside the discarded change", async () => {
  const { source } = start();
  runtime.wire(room(1)).ack();
  const acknowledged = Y.encodeStateAsUpdate(source.document);
  const gold = new Y.Doc({ gc: false }),
    survivor = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(gold, acknowledged);
    gold.clientID = 5001;
    gold.getText("text").insert(2, "gold");
    Y.applyUpdate(survivor, acknowledged);
    survivor.clientID = 6001;
    survivor.transact(() => {
      survivor.getText("text").delete(6, 5);
      survivor.getText("text").insert(6, "AZURE");
    });
    Y.applyUpdate(source.document, Y.encodeStateAsUpdate(gold), runtime.wire(room(1)));
    Y.applyUpdate(source.document, Y.encodeStateAsUpdate(survivor), runtime.wire(room(1)));
    source.document.getText("text").insert(4, "X");
    source.document.getText("text").insert(source.document.getText("text").length, "!");
    const sourceClient = source.document.clientID;
    await flush();
    reset(1);
    await flush();
    const wire = runtime.wire(room(2));
    wire.sync(Y.encodeStateAsUpdate(survivor));
    await flush();
    expect(wire.document.getText("text").toString()).toBe("hello AZURE!");
    expect(runtime.writerLoss).toHaveBeenCalledTimes(1);
    expect(runtime.changed).not.toHaveBeenCalled();
    const rescued = wire.sent
      .flatMap((update) => Y.decodeUpdate(update).structs)
      .filter((item) => item instanceof Y.Item && item.content instanceof Y.ContentString);
    expect(rescued).toHaveLength(1);
    expect(rescued[0]?.id.client).not.toBe(sourceClient);
    wire.ack();
    await flush();
    expect(runtime.writerChanges).toHaveBeenLastCalledWith(null);
    const admitted = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(admitted, Y.encodeStateAsUpdate(survivor));
      for (const update of wire.sent) Y.applyUpdate(admitted, update);
      expect(admitted.getText("text").toString()).toBe("hello AZURE!");
      expect(admitted.store.pendingStructs).toBeNull();
      expect(admitted.store.pendingDs).toBeNull();
    } finally {
      admitted.destroy();
    }
    runtime.pool.release("editor");
    runtime.pool.release("refresh");
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.pool.peek(room(2))).toBeUndefined();
    expect(runtime.writerLoss).toHaveBeenCalledTimes(1);
  } finally {
    gold.destroy();
    survivor.destroy();
  }
});
