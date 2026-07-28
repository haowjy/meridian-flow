import { describe, expect, it } from "vitest";

import { splitHashline, stripBlockHash, toHashline } from "./hashline.js";

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

describe("stripBlockHash", () => {
  it("removes the prefix a serialized block carries", () => {
    expect(stripBlockHash(toHashline("79b9", "The hollow gate stood."))).toBe(
      "The hollow gate stood.",
    );
  });

  it("removes a widened prefix", () => {
    // Hashes grow past four characters when siblings collide.
    expect(stripBlockHash("79b9c1a4f0|Beyond it, a path of pale stones.")).toBe(
      "Beyond it, a path of pale stones.",
    );
  });

  it("keeps a body that itself contains pipes", () => {
    expect(stripBlockHash("abc1|| Name | Role |")).toBe("| Name | Role |");
  });

  it("leaves a markdown table row alone", () => {
    // `search` returns raw markdown for schemes with no hashline shadow, so a
    // line that was never a hashline reaches this function routinely. Splitting
    // at the first pipe would eat the leading cell.
    expect(stripBlockHash("| Name | Role |")).toBe("| Name | Role |");
  });

  it("leaves prose that happens to contain a pipe alone", () => {
    expect(stripBlockHash("She paused | then went on.")).toBe("She paused | then went on.");
  });

  it("leaves a short non-hash prefix alone", () => {
    expect(stripBlockHash("a|b")).toBe("a|b");
  });

  it("leaves a non-hex prefix alone", () => {
    expect(stripBlockHash("chapter|two")).toBe("chapter|two");
  });

  it("leaves a line with no pipe alone", () => {
    expect(stripBlockHash("The hollow gate stood.")).toBe("The hollow gate stood.");
  });
});
