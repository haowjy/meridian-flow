import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manifestSha256 } from "./manifest.ts";
import { type PromotionPort, recordStatus, requireStagingVerified } from "./promotion.ts";
import { imageRepository, SERVICES } from "./release-identity.ts";

const sha = "a".repeat(40);
let directory: string;
let manifestPath: string;

function manifest() {
  return {
    version: "1.2.3",
    tag: "v1.2.3",
    sha,
    images: Object.fromEntries(
      SERVICES.map((service) => {
        const repository = imageRepository(service);
        const digest = `sha256:${"b".repeat(64)}`;
        return [service, { repository, digest, ref: `${repository}@${digest}` }];
      }),
    ),
  };
}

function port(statuses: unknown[] = [], writes: string[][] = []): PromotionPort {
  return {
    api<T>(args: string[]): T {
      if (args[0].includes("/git/ref/tags/")) return { object: { sha, type: "commit" } } as T;
      if (args[0].includes("/commits/")) return { statuses } as T;
      if (args[0].includes("/statuses/")) {
        writes.push(args);
        return {} as T;
      }
      throw new Error(`Unexpected API call ${args.join(" ")}`);
    },
  };
}

beforeEach(() => {
  process.env.GITHUB_REPOSITORY = "haowjy/meridian-flow";
  directory = mkdtempSync(join(tmpdir(), "promotion-"));
  manifestPath = join(directory, "release-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest())}\n`);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("promotion contract", () => {
  it("writes the exact status description that the reader accepts", async () => {
    const writes: string[][] = [];
    await recordStatus("staging", "v1.2.3", manifestPath, "success", port([], writes));
    const description = writes[0]
      .find((argument) => argument.startsWith("description="))
      ?.slice(12);
    expect(description).toBe(
      `staging deploy and smoke passed; manifest-sha256=${await manifestSha256(manifestPath)}`,
    );
    await expect(
      requireStagingVerified(
        "v1.2.3",
        manifestPath,
        port([
          { context: "deploy/staging", state: "success", description, created_at: "2026-01-01" },
        ]),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects missing, failed, and byte-mismatched staging verification", async () => {
    await expect(requireStagingVerified("v1.2.3", manifestPath, port())).rejects.toThrow(
      "no deploy/staging status",
    );
    await expect(
      requireStagingVerified(
        "v1.2.3",
        manifestPath,
        port([{ context: "deploy/staging", state: "failure" }]),
      ),
    ).rejects.toThrow("status is failure");
    await expect(
      requireStagingVerified(
        "v1.2.3",
        manifestPath,
        port([
          {
            context: "deploy/staging",
            state: "success",
            description: `staging deploy and smoke passed; manifest-sha256=${"c".repeat(64)}`,
          },
        ]),
      ),
    ).rejects.toThrow("does not match");
  });

  it("uses only the latest staging status", async () => {
    const hash = await manifestSha256(manifestPath);
    await expect(
      requireStagingVerified(
        "v1.2.3",
        manifestPath,
        port([
          {
            context: "deploy/staging",
            state: "success",
            description: `staging deploy and smoke passed; manifest-sha256=${hash}`,
            created_at: "2026-01-01",
          },
          { context: "deploy/staging", state: "failure", created_at: "2026-01-02" },
        ]),
      ),
    ).rejects.toThrow("status is failure");
  });
});
