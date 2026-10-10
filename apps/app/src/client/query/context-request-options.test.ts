import { describe, expect, it } from "vitest";
import { contextRequestOptionsForScheme } from "./context-request-options";

describe("a document request's owner", () => {
  it("names the lineage for a chat's Scratch and the Work for a Work's", () => {
    expect(contextRequestOptionsForScheme("scratch", { rootThreadId: "root" })).toEqual({
      rootThreadId: "root",
    });
    expect(contextRequestOptionsForScheme("scratch", { workId: "work" })).toEqual({
      workId: "work",
    });
    expect(contextRequestOptionsForScheme("uploads", { workId: "work" })).toEqual({
      workId: "work",
    });
  });

  it("names none for a project scheme and refuses a Work scheme with no owner", () => {
    expect(contextRequestOptionsForScheme("manuscript", { workId: null })).toBeUndefined();
    expect(() => contextRequestOptionsForScheme("scratch", { workId: null })).toThrow();
  });
});
