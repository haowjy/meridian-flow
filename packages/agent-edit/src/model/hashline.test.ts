import { describe, expect, it } from "vitest";

import { splitHashline, toHashline } from "./hashline.js";

describe("toHashline", () => {
  it("keeps a single-line body on the prefix line", () => {
    expect(toHashline("79b9", "The hollow gate stood at the edge.")).toBe(
      "79b9|The hollow gate stood at the edge.",
    );
  });

  it("starts a multi-line body on its own line", () => {
    expect(toHashline("79b9", "line one\nline two")).toBe("79b9|\nline one\nline two");
  });
});

describe("splitHashline", () => {
  it("inverts toHashline", () => {
    expect(splitHashline(toHashline("79b9", "The hollow gate stood."))).toEqual({
      hash: "79b9",
      body: "The hollow gate stood.",
    });
  });

  it("inverts toHashline for the empty hash serializeBlocks can emit", () => {
    expect(splitHashline(toHashline("", "A body with no hash."))).toEqual({
      hash: "",
      body: "A body with no hash.",
    });
  });

  it("splits at the first pipe, because that is where the writer put it", () => {
    expect(splitHashline("abc1|| Name | Role |")).toEqual({
      hash: "abc1",
      body: "| Name | Role |",
    });
  });

  it("reports a line with no separator rather than guessing which half it is", () => {
    // Callers disagree about what an unseparated line means: the trail readers
    // treat it as a body, the echo formatter as a hash. Only they know.
    expect(splitHashline("not a hashline")).toBeNull();
  });
});
