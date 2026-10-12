/** Missing or ambiguous schema offers must reach the version gate as unknown. */
import { describe, expect, it } from "vitest";
import { clientSchemaVersionFromSubprotocolHeader } from "./index.js";

describe("collab schema subprotocol offers", () => {
  const sentinel = { major: 0, minor: 0, patch: 0 };

  it.each([
    ["unrelated.v1, another", "zero matches"],
    ["meridian.collab.0.1.0, meridian.collab.0.2.0", "multiple matches"],
  ])("maps an %s header (%s) to the sentinel", (header, _case) => {
    expect(clientSchemaVersionFromSubprotocolHeader(header)).toEqual(sentinel);
  });
});
