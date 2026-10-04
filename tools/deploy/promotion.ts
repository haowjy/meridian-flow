/** Record deploy status and enforce byte-identical staging-to-production promotion. */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { manifestSha256, parseReleaseManifest } from "./manifest.ts";
import { parseTag } from "./release-identity.ts";

type CommitStatus = { context?: string; state?: string; description?: string; created_at?: string };
type StatusResponse = { statuses?: CommitStatus[] };
type TagObject = { object?: { sha?: string; type?: string } };

export type PromotionPort = {
  api<T>(args: string[]): T;
};

function githubPort(): PromotionPort {
  return {
    api<T>(args: string[]): T {
      const result = spawnSync("gh", ["api", ...args], { encoding: "utf8", env: process.env });
      if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
      return JSON.parse(result.stdout) as T;
    },
  };
}

function repository(): string {
  const value = process.env.GITHUB_REPOSITORY;
  if (!value) throw new Error("GITHUB_REPOSITORY is required");
  return value;
}

export function resolveTagCommit(tag: string, port: PromotionPort = githubPort()): string {
  if (!parseTag(tag)) throw new Error(`Invalid release tag '${tag}'`);
  const ref = port.api<TagObject>([`repos/${repository()}/git/ref/tags/${tag}`]);
  const object = ref.object;
  if (!object?.sha) throw new Error(`Tag ${tag} has no Git object`);
  if (object.type === "commit") return object.sha;
  if (object.type !== "tag") throw new Error(`Tag ${tag} does not resolve to a commit`);
  const annotated = port.api<TagObject>([`repos/${repository()}/git/tags/${object.sha}`]);
  if (annotated.object?.type !== "commit" || !annotated.object.sha)
    throw new Error(`Annotated tag ${tag} does not point to a commit`);
  return annotated.object.sha;
}

function description(environment: string, outcome: "success" | "failure", hash: string): string {
  const result = outcome === "success" ? "deploy and smoke passed" : "deploy failed";
  return `${environment} ${result}; manifest-sha256=${hash}`;
}

function descriptionHash(value: string): string | null {
  return (
    /^(?:staging|production) deploy and smoke passed; manifest-sha256=([a-f0-9]{64})$/.exec(
      value,
    )?.[1] ?? null
  );
}

export async function recordStatus(
  environment: string,
  tag: string,
  manifestPath: string,
  outcome: "success" | "failure",
  port: PromotionPort = githubPort(),
): Promise<void> {
  if (!["staging", "production"].includes(environment))
    throw new Error(`Unsupported environment '${environment}'`);
  const sha = resolveTagCommit(tag, port);
  const hash = outcome === "success" ? await manifestSha256(manifestPath) : "unavailable";
  port.api([
    `repos/${repository()}/statuses/${sha}`,
    "-f",
    `state=${outcome}`,
    "-f",
    `context=deploy/${environment}`,
    "-f",
    `description=${description(environment, outcome, hash)}`,
    "-f",
    `target_url=${process.env.GITHUB_SERVER_URL}/${repository()}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  ]);
}

export async function requireStagingVerified(
  tag: string,
  manifestPath: string,
  port: PromotionPort = githubPort(),
): Promise<void> {
  const sha = resolveTagCommit(tag, port);
  const manifest = parseReleaseManifest(await readFile(manifestPath, "utf8"));
  if (manifest.tag !== tag || manifest.sha !== sha)
    throw new Error(`Manifest identity does not match ${tag} at ${sha}`);
  const statuses =
    port.api<StatusResponse>([`repos/${repository()}/commits/${sha}/status`]).statuses ?? [];
  const latest = statuses
    .filter((status) => status.context === "deploy/staging")
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
    .at(-1);
  if (!latest) throw new Error(`${tag} has no deploy/staging status`);
  if (latest.state !== "success")
    throw new Error(`${tag} latest deploy/staging status is ${latest.state ?? "missing"}`);
  const stagedHash = descriptionHash(latest.description ?? "");
  if (!stagedHash) throw new Error(`${tag} deploy/staging status has no valid manifest SHA-256`);
  const manifestHash = await manifestSha256(manifestPath);
  if (manifestHash !== stagedHash)
    throw new Error(`${tag} manifest SHA-256 does not match the staging-verified bytes`);
}

async function main() {
  const [command, environmentOrTag, tagOrPath, pathOrOutcome, maybeOutcome] = process.argv.slice(2);
  if (command === "resolve-tag" && environmentOrTag)
    return console.log(resolveTagCommit(environmentOrTag));
  if (command === "require-staging" && environmentOrTag && tagOrPath)
    return requireStagingVerified(environmentOrTag, tagOrPath);
  if (command === "record" && environmentOrTag && tagOrPath && pathOrOutcome && maybeOutcome)
    return recordStatus(
      environmentOrTag,
      tagOrPath,
      pathOrOutcome,
      maybeOutcome as "success" | "failure",
    );
  throw new Error(
    "Usage: promotion.ts resolve-tag <tag> | require-staging <tag> <manifest> | record <environment> <tag> <manifest> <success|failure>",
  );
}

if (process.argv[1]?.endsWith("promotion.ts"))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
