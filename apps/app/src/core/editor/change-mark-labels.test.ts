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
    expect(changeMarkLabel("modify", 4)).toBe("AI deleted a passage");
  });

  it("renders actor and verb as one localized sentence", () => {
    expect(changeMarkLabel("insert", null, "Meridian Researcher")).toBe(
      "Meridian Researcher added a passage",
    );
    expect(collaboratorChangeLabel()).toBe("Collaborator edited text");
    expect(peerMarkAccessibleLabel("AI added a passage")).toBe(
      "Show change details for AI added a passage",
    );
  });
});
