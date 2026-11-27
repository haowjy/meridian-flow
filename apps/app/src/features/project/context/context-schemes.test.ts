import { CONTEXT_URI_SCHEME_NAMES, CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { describe, expect, it } from "vitest";

import { schemeLabel } from "./context-schemes";

describe("schemeLabel", () => {
  it("names each area as the shared map does", () => {
    for (const scheme of CONTEXT_URI_SCHEMES) {
      expect(schemeLabel(scheme)).toBe(CONTEXT_URI_SCHEME_NAMES[scheme]);
    }
  });
});
