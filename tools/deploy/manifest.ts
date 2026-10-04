/** Shared release-manifest validation, creation, and byte-level SHA-256. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { imageRepository, parseTag, SERVICES, type Service } from "./release-identity.ts";

export type Image = { repository: string; digest: string; ref: string };

export type ReleaseManifest = {
  version: string;
  tag: string;
  sha: string;
  images: Record<Service, Image>;
  builtAt?: string;
  runUrl?: string;
};

export function parseReleaseManifest(raw: string): ReleaseManifest {
  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(raw) as ReleaseManifest;
  } catch {
    throw new Error("Release manifest is not valid JSON");
  }
  if (
    !manifest ||
    !parseTag(manifest.tag) ||
    manifest.tag !== `v${manifest.version}` ||
    !/^[0-9a-f]{40}$/.test(manifest.sha)
  )
    throw new Error(
      "Manifest must include a matching version/tag and full 40-character release sha",
    );
  for (const service of SERVICES) {
    const image = manifest.images?.[service];
    if (
      !image ||
      image.repository !== imageRepository(service) ||
      !/^sha256:[0-9a-f]{64}$/.test(image.digest) ||
      image.ref !== `${image.repository}@${image.digest}`
    )
      throw new Error(
        `Manifest image '${service}' must contain its expected repository, sha256 digest, and matching digest ref`,
      );
  }
  return manifest;
}

export async function manifestSha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function main() {
  const [command, path, expectedTag, expectedSha] = process.argv.slice(2);
  if (command === "create" && path) {
    const version = process.env.VERSION ?? "";
    const tag = process.env.TAG ?? "";
    const sha = process.env.SHA ?? "";
    const images = Object.fromEntries(
      SERVICES.map((service) => {
        const repo = imageRepository(service);
        const digest = process.env[`${service.toUpperCase()}_DIGEST`] ?? "";
        return [service, { repository: repo, digest, ref: `${repo}@${digest}` }];
      }),
    );
    const manifest = parseReleaseManifest(
      JSON.stringify({
        version,
        tag,
        sha,
        images,
        builtAt: new Date().toISOString(),
        runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      }),
    );
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (command === "validate" && path) {
    const manifest = parseReleaseManifest(await readFile(path, "utf8"));
    if (expectedTag && manifest.tag !== expectedTag)
      throw new Error(`Manifest tag ${manifest.tag} does not match ${expectedTag}`);
    if (expectedSha && manifest.sha !== expectedSha)
      throw new Error(`Manifest sha ${manifest.sha} does not match ${expectedSha}`);
    return;
  }
  if (command === "sha256" && path) {
    console.log(await manifestSha256(path));
    return;
  }
  if (command === "resolve-tag" && path) {
    const result = spawnSync("git", ["tag", "--points-at", path, "v*"], { encoding: "utf8" });
    if (result.status !== 0)
      throw new Error(result.stderr.trim() || `Could not inspect tags at ${path}`);
    const tags = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((tag) => parseTag(tag));
    if (tags.length !== 1)
      throw new Error(
        `Expected exactly one release tag on ${path}; found ${tags.length}: ${tags.join(" ")}`,
      );
    console.log(tags[0]);
    return;
  }
  throw new Error(
    "Usage: manifest.ts create|validate|sha256 <path> [expected-tag] [expected-sha] | resolve-tag <sha>",
  );
}

if (process.argv[1]?.endsWith("manifest.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
