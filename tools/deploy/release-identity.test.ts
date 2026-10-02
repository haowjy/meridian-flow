import { describe, expect, it } from "vitest";
import {
  imageRepository,
  parseTag,
  RAILWAY_CLI_VERSION,
  releaseSubject,
  runReleaseIdentity,
  SERVICES,
} from "./release-identity.ts";

describe("release identity", () => {
  it("accepts stable and release-candidate tags only", () => {
    expect(parseTag("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3, rc: null });
    expect(parseTag("v1.2.3-rc.4")).toMatchObject({ rc: 4 });
    for (const invalid of ["1.2.3", "v1.2", "v1.2.3-rc", "v1.2.3-beta.1"])
      expect(parseTag(invalid)).toBeNull();
  });
  it("owns release subjects, services, repositories, and the Railway pin", () => {
    expect(releaseSubject("v1.2.3")).toBe("release: v1.2.3");
    expect(() => releaseSubject("latest")).toThrow("Invalid release tag");
    expect(SERVICES.map(imageRepository)).toEqual([
      "ghcr.io/haowjy/meridian-flow-server",
      "ghcr.io/haowjy/meridian-flow-app",
      "ghcr.io/haowjy/meridian-flow-www",
      "ghcr.io/haowjy/meridian-flow-ingress",
    ]);
    expect(RAILWAY_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each([
    ["Merge pull request #1", [], 0, "false"],
    ["release: v1.2.3", ["v1.2.3"], 0, "true"],
    ["release: v1.2.3", [], 1, ""],
    ["release: v1.2.3", ["v1.2.3", "v1.2.4"], 1, ""],
  ])("identifies subject %j with tags %j", (subject, tags, expectedCode, expectedOutput) => {
    const output: string[] = [];
    const errors: string[] = [];
    const code = runReleaseIdentity(["identify-release", "abc123"], {
      git: (args) => (args[0] === "show" ? subject : tags.join("\n")),
      log: (message) => output.push(message),
      error: (message) => errors.push(message),
    });
    expect(code).toBe(expectedCode);
    expect(output.join("\n")).toBe(expectedOutput);
    if (expectedCode === 1)
      expect(errors.join("\n")).toContain(
        "Release commit abc123 (release: v1.2.3) must have exactly its one canonical tag. Re-run Release on Merge.",
      );
  });
});
