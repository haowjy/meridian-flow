/** Writer delivery across real session retirement, sync and acknowledgement boundaries. */
import { branchRoomName } from "@meridian/contracts/protocol";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { HttpResponseError } from "@/client/api/http-client";
import { branchHandoffHarness } from "@/test-support/branch-handoff-harness";

let runtime: ReturnType<typeof branchHandoffHarness>;
const room = (generation: number) => branchRoomName("handoff", generation);
const flush = () => vi.advanceTimersByTimeAsync(0);
function start(mixed = false) {
  vi.useFakeTimers();
  runtime = branchHandoffHarness();
  runtime.pool.retain("editor", [runtime.ref(room(1))]);
  runtime.pool.retain("refresh", [runtime.ref(room(1))]);
  const source = runtime.pool.get(room(1));
  const base = new Y.Doc({ gc: false });
  base.getText("text").insert(0, "hello");
  const baseline = Y.encodeStateAsUpdate(base);
  base.destroy();
  runtime.wire(room(1)).sync(baseline);
  runtime.wire(room(1)).ack();
  if (mixed) {
    const ai = new Y.Doc({ gc: false });
    Y.applyUpdate(ai, baseline);
    const vector = Y.encodeStateVector(ai);
    ai.getText("text").delete(2, 1);
    ai.getText("text").insert(4, "AI");
    Y.applyUpdate(source.document, Y.encodeStateAsUpdate(ai, vector), runtime.wire(room(1)));
    source.document.getText("text").insert(0, " WORLD");
    source.document.getText("text").delete(6, 1);
    source.document.getText("text").insert(source.document.getText("text").length, "LOST");
    ai.destroy();
  } else source.document.getText("text").insert(5, " WORLD");
  runtime.locate(async () => room(2));
  return { source, baseline };
}
function reset(generation: number, rebuild = false) {
  runtime.wire(room(generation)).emit({
    kind: "reset",
    reason: rebuild ? "branch-stale-doc" : "branch-generation-stale",
    disposition: rebuild ? "rebuild" : "superseded",
  });
}
async function delivered(generation: number, expected: string, baseline: Uint8Array) {
  await flush();
  const wire = runtime.wire(room(generation));
  wire.sync(baseline);
  await flush();
  const session = runtime.pool.peek(room(generation))!;
  expect(session.document.getText("text").toString()).toBe(expected);
  expect(session.document.store.pendingStructs).toBeNull();
  expect(session.document.store.pendingDs).toBeNull();
  expect(wire.sent.length).toBeGreaterThan(0);
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
  const { source, baseline } = start(mode === "same room");
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
  await delivered(target, mode === "same room" ? " WORLDello" : "hello WORLD", baseline);
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
