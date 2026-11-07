import { IMPORT_ADMISSION } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import { planBatches } from "./batching";

describe("planBatches", () => {
  it("packs small files, sends a big one alone and never exceeds the part budget", () => {
    const small = Array.from({ length: 450 }, (_, entryId) => ({ entryId, size: 10 }));
    const batches = planBatches([
      ...small,
      { entryId: 900, size: IMPORT_ADMISSION.requestBytes + 1 },
      { entryId: 901, size: 5 },
    ]);
    expect(batches.map((batch) => batch.length)).toEqual([200, 200, 50, 1, 1]);
    expect(batches[3][0].entryId).toBe(900);
  });

  it("starts a new request when the byte budget would be crossed", () => {
    const half = IMPORT_ADMISSION.requestBytes / 2;
    const batches = planBatches([
      { entryId: 1, size: half },
      { entryId: 2, size: half },
      { entryId: 3, size: 1 },
    ]);
    expect(batches.map((batch) => batch.map((item) => item.entryId))).toEqual([[1, 2], [3]]);
  });
});
