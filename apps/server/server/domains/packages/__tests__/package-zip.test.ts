import { describe, expect, it } from "vitest";

import { buildMarsPackageZip } from "../domain/package-zip.js";

describe("buildMarsPackageZip", () => {
  it("builds a zip containing mars package files", () => {
    const zip = buildMarsPackageZip({
      files: {
        "mars.toml": '[package]\nname = "pkg"\n',
        "agents/agent-one.md": "# Agent\n",
      },
    });

    expect(zip.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(zip.includes(Buffer.from("mars.toml"))).toBe(true);
    expect(zip.includes(Buffer.from("agent-one.md"))).toBe(true);
  });
});
