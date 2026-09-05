import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AccessFenceKey,
  DocumentFenceKey,
  LiveDocumentSessionAuthority,
  LiveDocumentSessionLease,
} from "./context-availability.js";
import { assertAvailabilityGeneration } from "./context-availability.js";

describe("live document session authority contracts", () => {
  it("keeps account, project, document, and generation mandatory", () => {
    expectTypeOf<LiveDocumentSessionLease>().toEqualTypeOf<{
      accountId: string;
      projectId: string;
      documentId: string;
      generation: string;
    }>();
    expectTypeOf<DocumentFenceKey>().toMatchTypeOf<`document/${string}/${string}`>();
    expectTypeOf<AccessFenceKey>().toMatchTypeOf<`access/${string}/${string}/${string}`>();
    expectTypeOf<LiveDocumentSessionAuthority["admit"]>().parameters.toEqualTypeOf<
      [string, string, string]
    >();
  });

  it("accepts only canonical nonnegative decimal generations", () => {
    for (const generation of ["0", "1", "10", "99999999999999999999"]) {
      expect(() => assertAvailabilityGeneration(generation)).not.toThrow();
    }
    for (const generation of ["", "+1", "-1", " 1", "1 ", "0x10", "01", "00"]) {
      expect(() => assertAvailabilityGeneration(generation)).toThrow(TypeError);
    }
  });
});
