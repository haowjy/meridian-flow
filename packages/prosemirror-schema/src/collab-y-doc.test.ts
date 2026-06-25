import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCollabYDoc, isReservedClientId, RESERVED_CLIENT_ID_MAX } from "./index.js";

const randomState = vi.hoisted(() => ({
  draws: [] as number[],
  getRandomValues: vi.fn((array: Uint32Array) => {
    const next = randomState.draws.shift();
    if (next === undefined) throw new Error("unexpected clientID draw");
    array[0] = next;
    return array;
  }),
}));

vi.mock("lib0/webcrypto", () => ({
  subtle: undefined,
  getRandomValues: randomState.getRandomValues,
}));

describe("reserved Yjs clientID protocol", () => {
  beforeEach(() => {
    randomState.draws = [];
    randomState.getRandomValues.mockClear();
  });

  it("re-rolls when Yjs draws a reserved clientID", () => {
    const safeDraw = RESERVED_CLIENT_ID_MAX + 1;
    randomState.draws.push(RESERVED_CLIENT_ID_MAX, safeDraw);

    const doc = createCollabYDoc({ guid: "reserved-then-safe" });

    expect(doc.clientID).toBe(safeDraw);
    expect(randomState.getRandomValues).toHaveBeenCalledTimes(2);
  });

  it("keeps a normal Yjs clientID draw", () => {
    const safeClientId = RESERVED_CLIENT_ID_MAX + 1;
    randomState.draws.push(safeClientId);

    const doc = createCollabYDoc({ guid: "safe" });

    expect(doc.clientID).toBe(safeClientId);
    expect(randomState.getRandomValues).toHaveBeenCalledTimes(1);
  });

  it("identifies reserved clientID band boundaries", () => {
    expect(isReservedClientId(0)).toBe(true);
    expect(isReservedClientId(999)).toBe(true);
    expect(isReservedClientId(1000)).toBe(false);
  });
});
