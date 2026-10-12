/** Discard request parsing keeps malformed or unfenced selections from becoming whole commands. */
import { describe, expect, it } from "vitest";
import { parseDraftDiscardSelection } from "./draft-review-route.js";

describe("Discard request selection", () => {
  it.each([
    [],
    [123],
    ["valid", 123],
    null,
    "valid",
    [""],
  ])("rejects malformed selection %j", (ids) => {
    expect(() => parseDraftDiscardSelection({ operationIds: ids })).toThrow();
  });
  it("reserves whole Discard for a genuinely absent selection", () => {
    expect(parseDraftDiscardSelection({})).toEqual({ status: "ready", command: {} });
    expect(() => parseDraftDiscardSelection({ liveRevisionToken: "live" })).toThrow();
    expect(() => parseDraftDiscardSelection({ closureClassIds: ["class"] })).toThrow();
    expect(() => parseDraftDiscardSelection({ admissionTokens: ["token"] })).toThrow();
  });
  it("refuses missing selective admission evidence as stale", () => {
    expect(parseDraftDiscardSelection({ operationIds: ["1"] })).toEqual({ status: "stale" });
    expect(
      parseDraftDiscardSelection({
        operationIds: ["1"],
        liveRevisionToken: "live",
        draftRevisionToken: "draft",
        closureClassIds: ["class"],
      }),
    ).toEqual({ status: "stale" });
  });
  it("keeps the complete typed selective command", () => {
    const command = {
      closureClassIds: ["class"],
      admissionTokens: ["class"],
      operationIds: ["1"],
      liveRevisionToken: "live",
      draftRevisionToken: "draft",
    };
    expect(parseDraftDiscardSelection(command)).toEqual({ status: "ready", command });
  });
});
