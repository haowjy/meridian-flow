import { describe, expect, it } from "vitest";

import { detectDuplicateTopLevelContent } from "./duplicate-content-guard.js";

const block = (hash: string, body: string) => ({ hash, serialized: `${hash}|${body}` });

describe("duplicate top-level content guard", () => {
  it("rejects a whole document reintroduced as one multiline block", () => {
    const before = [block("a", "Alpha"), block("b", "Beta"), block("c", "Gamma")];
    const after = [...before, block("d", "Alpha\nBeta\nGamma")];

    expect(
      detectDuplicateTopLevelContent({ protectedSnapshots: [before], before, after }),
    ).toMatchObject({ ok: false, reason: "duplicate_top_level_sequence" });
  });

  it("rejects a contiguous multi-block sequence reintroduced as new top-level blocks", () => {
    const before = [block("a", "Alpha"), block("b", "Beta"), block("c", "Gamma")];
    const after = [...before, block("d", "Beta"), block("e", "Gamma")];

    expect(
      detectDuplicateTopLevelContent({ protectedSnapshots: [before], before, after }),
    ).toMatchObject({ ok: false });
  });

  it("allows a single intentionally repeated block", () => {
    const before = [block("a", "Alpha"), block("b", "Beta")];
    const after = [...before, block("c", "Alpha")];

    expect(detectDuplicateTopLevelContent({ protectedSnapshots: [before], before, after }).ok).toBe(
      true,
    );
  });

  it("allows genuinely new appended content", () => {
    const before = [block("a", "Alpha"), block("b", "Beta")];
    const after = [...before, block("c", "Gamma"), block("d", "Delta")];

    expect(detectDuplicateTopLevelContent({ protectedSnapshots: [before], before, after }).ok).toBe(
      true,
    );
  });
});
