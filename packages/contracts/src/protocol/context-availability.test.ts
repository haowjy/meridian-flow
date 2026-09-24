import { describe, expect, it } from "vitest";
import { assertAvailabilityGeneration } from "./context-availability.js";

describe("live document session authority contracts", () => {
  it("accepts only canonical nonnegative decimal generations", () => {
    for (const generation of ["0", "1", "10", "99999999999999999999"]) {
      expect(() => assertAvailabilityGeneration(generation)).not.toThrow();
    }
    for (const generation of ["", "+1", "-1", " 1", "1 ", "0x10", "01", "00"]) {
      expect(() => assertAvailabilityGeneration(generation)).toThrow(TypeError);
    }
  });
});
