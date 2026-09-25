/** Resolve an annotated or lightweight v-tag to its peeled commit SHA with gh. */
import { spawnSync } from "node:child_process";

function ghJson(args: string[]): Record<string, unknown> {
  const result = spawnSync("gh", ["api", ...args], { encoding: "utf8", env: process.env });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

export function resolveTagCommit(tag: string): string {
  if (!/^v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(tag)) throw new Error(`Invalid release tag '${tag}'`);
  const ref = ghJson([`repos/${process.env.GITHUB_REPOSITORY}/git/ref/tags/${tag}`]);
  const object = ref.object as { sha?: string; type?: string } | undefined;
  if (!object?.sha) throw new Error(`Tag ${tag} has no Git object`);
  if (object.type === "commit") return object.sha;
  if (object.type !== "tag") throw new Error(`Tag ${tag} does not resolve to a commit`);
  const annotated = ghJson([`repos/${process.env.GITHUB_REPOSITORY}/git/tags/${object.sha}`]);
  const target = annotated.object as { sha?: string; type?: string } | undefined;
  if (target?.type !== "commit" || !target.sha)
    throw new Error(`Annotated tag ${tag} does not point to a commit`);
  return target.sha;
}

if (process.argv[1]?.endsWith("release-commit.ts")) {
  try {
    console.log(resolveTagCommit(process.argv[2] ?? ""));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
