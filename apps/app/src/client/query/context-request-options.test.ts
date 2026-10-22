import { describe, expect, it } from "vitest";
import { contextRequestOptionsForScheme } from "./context-request-options";

describe("a document request's owner", () => {
  it("names the lineage for a chat's Scratch, the Work for a Work's and the chat for uploads", () => {
    expect(contextRequestOptionsForScheme("scratch", { rootThreadId: "root" })).toEqual({
      rootThreadId: "root",
    });
    expect(contextRequestOptionsForScheme("scratch", { workId: "work" })).toEqual({
      workId: "work",
    });
    expect(contextRequestOptionsForScheme("uploads", { chatThreadId: "chat" })).toEqual({
      chatThreadId: "chat",
    });
  });

  it("names none for a project scheme and refuses a Work scheme with no owner", () => {
    expect(contextRequestOptionsForScheme("manuscript", { workId: null })).toBeUndefined();
    expect(() => contextRequestOptionsForScheme("scratch", { workId: null })).toThrow();
  });
});
