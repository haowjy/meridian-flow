// @vitest-environment jsdom
/** Intent liveness is distinct from a live request and lasts through failed derivation. */
import { afterEach, expect, it, vi } from "vitest";
import {
  derivationWitness,
  holdDerivationIntent,
  releaseDerivationIntent,
} from "./derivation-witness";

afterEach(() => vi.unstubAllGlobals());
it("another tab's held intent is pending until it leaves; fresh evidence is read under the exclusive claim", async () => {
  const held = new Set<string>();
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        name: string,
        options: unknown,
        callback?: (lock: object | null) => Promise<unknown>,
      ) => {
        if (typeof options === "function") {
          held.add(name);
          await options({});
          held.delete(name);
          return;
        }
        return callback?.(held.has(name) ? null : {});
      },
    },
  });
  holdDerivationIntent("writer", "fork");
  const witness = derivationWitness("writer", () => null);
  expect(await witness.probe("fork", async (pending) => pending)).toBe(true);
  releaseDerivationIntent("writer", "fork");
  await Promise.resolve();
  expect(await witness.probe("fork", async (pending) => pending)).toBe(false);
});
it("without Web Locks only this tab's creating or failed status counts", async () => {
  vi.stubGlobal("navigator", {});
  for (const state of ["creating", "failed", "created", null] as const) {
    const witness = derivationWitness("writer", () => state);
    expect(await witness.probe("fork", async (pending) => pending)).toBe(
      state === "creating" || state === "failed",
    );
  }
});
