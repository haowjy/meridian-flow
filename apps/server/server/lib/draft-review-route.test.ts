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
    expect(() => parseDraftDiscardSelection({ closureClassIds: ids })).toThrow();
  });
  it("reserves whole Discard for a genuinely absent selection", () => {
    expect(parseDraftDiscardSelection({})).toEqual({ status: "ready", command: {} });
    expect(() => parseDraftDiscardSelection({ liveRevisionToken: "live" })).toThrow();
    expect(() => parseDraftDiscardSelection({ admissionTokens: ["token"] })).toThrow();
    expect(() => parseDraftDiscardSelection({ memberPartKeys: ["part:0"] })).toThrow();
  });
  it("refuses missing selective admission evidence as stale", () => {
    expect(parseDraftDiscardSelection({ closureClassIds: ["1"] })).toEqual({ status: "stale" });
    expect(
      parseDraftDiscardSelection({
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
      memberPartKeys: ["edit:0"],
      liveRevisionToken: "live",
      draftRevisionToken: "draft",
    };
    expect(parseDraftDiscardSelection(command)).toEqual({ status: "ready", command });
  });
  it.each([
    undefined,
    null,
    "edit:0",
    [123],
    [""],
  ])("refuses invalid member evidence %j", (memberPartKeys) => {
    expect(
      parseDraftDiscardSelection({
        closureClassIds: ["class"],
        admissionTokens: ["token"],
        liveRevisionToken: "live",
        draftRevisionToken: "draft",
        memberPartKeys,
      }),
    ).toEqual({ status: "stale" });
  });
  it("allows an empty part list for fallback-only classes", () => {
    const command = {
      closureClassIds: ["class"],
      admissionTokens: ["token"],
      liveRevisionToken: "live",
      draftRevisionToken: "draft",
      memberPartKeys: [],
    };
    expect(parseDraftDiscardSelection(command)).toEqual({ status: "ready", command });
  });
});
