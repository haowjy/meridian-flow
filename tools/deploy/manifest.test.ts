import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manifestSha256, parseReleaseManifest } from "./manifest.ts";

function fixture() {
  return JSON.stringify({
    version: "1.2.3",
    tag: "v1.2.3",
    sha: "a".repeat(40),
    images: Object.fromEntries(
      ["server", "app", "www", "ingress"].map((service) => {
        const repository = `ghcr.io/haowjy/meridian-flow-${service}`;
        const digest = `sha256:${"b".repeat(64)}`;
        return [service, { repository, digest, ref: `${repository}@${digest}` }];
      }),
    ),
  });
}

describe("release manifest", () => {
  it("validates all four digest-pinned images and the release identity", () => {
    expect(parseReleaseManifest(fixture()).tag).toBe("v1.2.3");
  });

  it("rejects tag/sha and image-ref mismatches", () => {
    expect(() =>
      parseReleaseManifest(fixture().replace('"tag":"v1.2.3"', '"tag":"v9.9.9"')),
    ).toThrow();
    expect(() => parseReleaseManifest(fixture().replaceAll("@sha256:", "@sha256:bad"))).toThrow();
  });

  it("hashes the exact manifest bytes used as a promotion contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-manifest-"));
    try {
      const path = join(dir, "release-manifest.json");
      writeFileSync(path, `${fixture()}\n`);
      const expected = createHash("sha256").update(readFileSync(path)).digest("hex");
      expect(await manifestSha256(path)).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
