import { describe, expect, it } from "vitest";
import { chatScratchOwner } from "./chat-scratch-owner";

const thread = { rootThreadId: "root-c12" };
const noWork = { id: "no-work", isNoWork: true };
const arc = { id: "arc", isNoWork: false };

describe("a chat's Scratch owner", () => {
  it("is the lineage on No Work and the Work on a named Work", () => {
    expect(chatScratchOwner({ thread, work: noWork })).toEqual({
      kind: "lineage",
      rootThreadId: "root-c12",
    });
    expect(chatScratchOwner({ thread, work: arc })).toEqual({ kind: "work", workId: "arc" });
  });

  it("is unknown until the chat's Work is", () => {
    expect(chatScratchOwner({ thread, work: null })).toBeNull();
    expect(chatScratchOwner({ thread: null, work: noWork })).toBeNull();
  });
});
