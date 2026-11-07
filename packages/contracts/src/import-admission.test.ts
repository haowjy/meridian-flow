import { describe, expect, it } from "vitest";
import { IMPORT_ADMISSION, overFileBudget } from "./import-admission.js";

describe("the shared file budget", () => {
  const limit = IMPORT_ADMISSION.files;
  it("counts unreadable items against the same limit as readable files", () => {
    expect(overFileBudget(limit, 0)).toBe(false);
    expect(overFileBudget(limit + 1, 0)).toBe(true);
    expect(overFileBudget(limit - 1, 1)).toBe(false);
    // The case the browser used to pass and the server refuse.
    expect(overFileBudget(limit - 1, 2)).toBe(true);
  });
});
