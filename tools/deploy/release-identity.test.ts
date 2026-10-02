import { describe, expect, it } from "vitest";
import {
  imageRepository,
  parseTag,
  RAILWAY_CLI_VERSION,
  releaseSubject,
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
});
