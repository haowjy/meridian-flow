/** Writer-facing peer-mark label contracts. */
import { describe, expect, it } from "vitest";
import {
  changeKindLabel,
  changeMarkLabel,
  collaboratorChangeLabel,
  peerMarkAccessibleLabel,
} from "./change-mark-labels";

describe("peer-mark labels", () => {
  it.each([
    ["insert", "Added a passage"],
    ["modify", "Replaced a passage"],
    ["delete", "Deleted a passage"],
  ] as const)("describes an AI %s as a sentence-case verb phrase", (kind, expected) => {
    expect(changeKindLabel(kind)).toBe(expected);
  });

  it("labels a pure deletion by its rendered effect", () => {
    expect(changeMarkLabel("modify", 4)).toBe("Deleted a passage");
  });

  it("keeps optional identity separate from the localized verb", () => {
    expect(changeMarkLabel("insert", null, "Meridian Researcher")).toBe(
      "Meridian Researcher · Added a passage",
    );
    expect(collaboratorChangeLabel()).toBe("Collaborator edited text");
    expect(peerMarkAccessibleLabel("AI · Added a passage")).toBe(
      "Show change details for AI · Added a passage",
    );
  });
});
