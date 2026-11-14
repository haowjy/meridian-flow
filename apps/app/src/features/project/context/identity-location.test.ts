import { describe, expect, it } from "vitest";
import { identityDestination, type TabLocation } from "./identity-location";

const lineageNote: TabLocation = {
  scheme: "scratch",
  parentPath: "/duel",
  folders: ["duel"],
  leaf: "beats.md",
  provisional: false,
  editable: true,
  path: "/duel/beats.md",
  rootThreadId: "root-c12",
  rootThreadRef: "c12",
};

describe("a document's placement owner", () => {
  it("keeps a chat's Scratch note in its lineage, whatever Work the Editor shows", () => {
    expect(identityDestination(lineageNote, "editor-work")).toMatchObject({
      scheme: "scratch",
      rootThreadId: "root-c12",
      rootThreadRef: "c12",
      workId: undefined,
    });
  });

  it("drops the lineage when the note moves out of Scratch", () => {
    const moved = identityDestination(lineageNote, "editor-work", {
      scheme: "manuscript",
      folderPath: "/",
    });
    expect(moved.rootThreadId).toBeUndefined();
    expect(moved.workId).toBeUndefined();
  });
});
