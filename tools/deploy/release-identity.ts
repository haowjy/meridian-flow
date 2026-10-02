/** Canonical release tag, image, service, and deploy-tool identity. */
import { spawnSync } from "node:child_process";
export const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;
export type ReleaseTag = {
  tag: string;
  major: number;
  minor: number;
  patch: number;
  rc: number | null;
};

export function parseTag(tag: string): ReleaseTag | null {
  const match = TAG_RE.exec(tag);
  if (!match) return null;
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: match[4] === undefined ? null : Number(match[4]),
  };
}

export function releaseSubject(tag: string): string {
  if (!parseTag(tag)) throw new Error(`Invalid release tag '${tag}'`);
  return `release: ${tag}`;
}

export const SERVICES = ["server", "app", "www", "ingress"] as const;
export type Service = (typeof SERVICES)[number];
export function imageRepository(service: Service): string {
  return `ghcr.io/haowjy/meridian-flow-${service}`;
}
export const RAILWAY_CLI_VERSION = "5.62.1";

type CliIo = {
  git(args: string[]): string;
  log(message: string): void;
  error(message: string): void;
};

const commandIo: CliIo = {
  git(args) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.status !== 0)
      throw new Error(
        `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || `git ${args.join(" ")} failed`,
      );
    return result.stdout.trim();
  },
  log: console.log,
  error: console.error,
};

function releaseCommit(sha: string, io: CliIo): boolean {
  const subject = io.git(["show", "-s", "--format=%s", sha]);
  const subjectTag = subject.startsWith("release: ") ? subject.slice("release: ".length) : "";
  if (!parseTag(subjectTag) || subject !== releaseSubject(subjectTag)) return false;

  const tags = io
    .git(["tag", "--points-at", sha, "v*"])
    .split("\n")
    .filter((tag) => parseTag(tag));
  if (tags.length !== 1 || tags[0] !== subjectTag)
    throw new Error(
      `Release commit ${sha} (${subject}) must have exactly its one canonical tag. Re-run Release on Merge.`,
    );
  return true;
}

export function runReleaseIdentity(args: string[], io: CliIo): number {
  try {
    const [command, value] = args;
    if (command === "identify-release" && value) {
      io.log(releaseCommit(value, io) ? "true" : "false");
      return 0;
    }
    if (command === "services") io.log(SERVICES.join(" "));
    else if (command === "image-repository" && SERVICES.includes(value as Service))
      io.log(imageRepository(value as Service));
    else if (command === "railway-version") io.log(RAILWAY_CLI_VERSION);
    else if (command === "release-subject" && value) io.log(releaseSubject(value));
    else
      throw new Error(
        "Usage: release-identity.ts services | image-repository <service> | railway-version | release-subject <tag> | identify-release <sha>",
      );
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function main() {
  process.exitCode = runReleaseIdentity(process.argv.slice(2), commandIo);
}
if (process.argv[1]?.endsWith("release-identity.ts")) {
  main();
}
