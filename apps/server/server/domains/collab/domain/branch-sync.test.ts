/** Property coverage for the pure Yjs branch sync primitive. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { sync } from "./branch-sync.js";

type DecodedUpdate = ReturnType<typeof Y.decodeUpdate> & {
  structs: readonly unknown[];
  ds: { clients: ReadonlyMap<number, readonly unknown[]> };
};

const BODY = "body";

function createBranchDoc(): Y.Doc {
  return new Y.Doc({ gc: false });
}

function bodyText(doc: Y.Doc): Y.Text {
  return doc.getText(BODY);
}

function forkFrom(doc: Y.Doc): Y.Doc {
  const fork = createBranchDoc();
  Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc));
  return fork;
}

function stateBytes(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

function expectSameState(left: Y.Doc, right: Y.Doc): void {
  expect(equalBytes(stateBytes(left), stateBytes(right))).toBe(true);
}

function expectSameBytes(left: Uint8Array, right: Uint8Array): void {
  expect(equalBytes(left, right)).toBe(true);
}

function expectEmptyDiff(update: Uint8Array): void {
  const decoded = Y.decodeUpdate(update) as DecodedUpdate;
  expect(decoded.structs).toHaveLength(0);
  expect(decoded.ds.clients.size).toBe(0);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomInt(random: () => number, exclusiveMax: number): number {
  return Math.floor(random() * exclusiveMax);
}

function randomToken(random: () => number): string {
  return String.fromCharCode(97 + randomInt(random, 26));
}

describe("branch sync", () => {
  it("is idempotent after the target has caught up", () => {
    const a = createBranchDoc();
    const b = createBranchDoc();
    bodyText(a).insert(0, "alpha beta");

    sync(a, b);
    const beforeSecondSync = stateBytes(b);
    const expectedSecondUpdate = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));

    const secondUpdate = sync(a, b);

    expectSameBytes(secondUpdate, expectedSecondUpdate);
    expectEmptyDiff(secondUpdate);
    expectSameBytes(stateBytes(b), beforeSecondSync);
  });

  it("converges byte-identical state after concurrent same-position edits", () => {
    const seed = createBranchDoc();
    bodyText(seed).insert(0, "middle");
    const a = forkFrom(seed);
    const b = forkFrom(seed);

    bodyText(a).insert(3, "[from-a]");
    bodyText(b).insert(3, "[from-b]");
    bodyText(a).insert(0, "A:");
    bodyText(b).insert(bodyText(b).length, ":B");

    sync(a, b);
    sync(b, a);

    expectSameState(a, b);
  });

  it("catches up forks and returns bytes sufficient for journal replay", () => {
    const a = createBranchDoc();
    bodyText(a).insert(0, "seed");
    const b = forkFrom(a);
    const replay = forkFrom(b);

    bodyText(a).insert(bodyText(a).length, " advanced");
    bodyText(a).insert(0, "live ");

    const expectedUpdate = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const update = sync(a, b);
    Y.applyUpdate(replay, update);

    expectSameBytes(update, expectedUpdate);
    expectSameState(a, b);
    expectSameState(a, replay);
  });

  it("propagates deletions even when the target state vector does not advance", () => {
    const a = createBranchDoc();
    bodyText(a).insert(0, "abcdef");
    const b = forkFrom(a);
    const stateVectorBeforeDeleteSync = Y.encodeStateVector(b);

    bodyText(a).delete(2, 2);

    const expectedUpdate = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const update = sync(a, b);
    const decoded = Y.decodeUpdate(update) as DecodedUpdate;

    expectSameBytes(update, expectedUpdate);
    expect(decoded.structs).toHaveLength(0);
    expect(decoded.ds.clients.size).toBeGreaterThan(0);
    expectSameBytes(Y.encodeStateVector(b), stateVectorBeforeDeleteSync);
    expect(bodyText(b).toString()).toBe("abef");
    expectSameState(a, b);
  });

  it("converges under seeded random interleaved edits with periodic bidirectional sync", () => {
    const random = createSeededRandom(0xc0ffee);
    const a = createBranchDoc();
    const b = createBranchDoc();

    for (let step = 0; step < 500; step += 1) {
      const target = random() < 0.5 ? a : b;
      const text = bodyText(target);
      const shouldInsert = text.length === 0 || random() < 0.65;

      if (shouldInsert) {
        text.insert(randomInt(random, text.length + 1), randomToken(random));
      } else {
        const index = randomInt(random, text.length);
        const maxLength = Math.min(3, text.length - index);
        text.delete(index, 1 + randomInt(random, maxLength));
      }

      if (step % 7 === 0) sync(a, b);
      if (step % 11 === 0) sync(b, a);
      if (step % 37 === 0) {
        sync(a, b);
        sync(b, a);
        expectSameState(a, b);
      }
    }

    sync(a, b);
    sync(b, a);

    expectSameState(a, b);
  });
});
