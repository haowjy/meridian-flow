/** The review list's fingerprint cache must never outlive a journal append or an open room. */
import { expect, it, vi } from "vitest";
import { createLiveFingerprintReader } from "./live-fingerprint-reader.js";

function setup() {
  const state = { head: "1", room: false, text: "a" };
  const read = vi.fn(async () => `fp:${state.text}`);
  const db = {
    select: () => ({
      from: () => ({
        where: async () => [{ authorityId: "auth", generation: 1n, next: state.head }],
      }),
    }),
  };
  const fingerprint = createLiveFingerprintReader({
    db: db as never,
    roomOpen: () => state.room,
    read,
  });
  return { state, read, fingerprint };
}

it("reads once while the admission head holds, and again after any append", async () => {
  const { state, read, fingerprint } = setup();
  expect(await fingerprint("doc")).toBe("fp:a");
  expect(await fingerprint("doc")).toBe("fp:a");
  expect(read).toHaveBeenCalledTimes(1);
  // A deletion-only edit still allocates an admission, so the head moves.
  state.head = "2";
  state.text = "b";
  expect(await fingerprint("doc")).toBe("fp:b");
  expect(read).toHaveBeenCalledTimes(2);
});

it("never serves a cached value while a room is open", async () => {
  const { state, read, fingerprint } = setup();
  await fingerprint("doc");
  state.room = true;
  state.text = "unstored";
  expect(await fingerprint("doc")).toBe("fp:unstored");
  state.room = false;
  state.text = "stored";
  expect(await fingerprint("doc")).toBe("fp:stored");
  expect(read).toHaveBeenCalledTimes(3);
});
