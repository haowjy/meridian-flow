/** Typed release policy and its Git/GitHub command adapters. */
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseTag, releaseSubject } from "../deploy/release-identity.ts";

export type ReleaseIntent = {
  release: boolean;
  kind: "skip" | "rc" | "stable";
  bump?: "patch" | "minor" | "major";
};
export type HistoryCommit = { sha: string; subject: string; tags: string[] };
export type PullRequest = {
  number: number;
  merged_at: string | null;
  base: { ref: string };
  merge_commit_sha: string | null;
  labels: Array<{ name: string }>;
};
export type BatchCommit = { sha: string; labels: string[]; skipTrailer?: boolean };

export interface GitPort {
  fetchMain(): void;
  firstParent(): HistoryCommit[];
  workflowIntroduction(): string | null;
  message(sha: string): string;
  tags(): string[];
  tagCommit(tag: string): string | null;
  createTag(tag: string, commit: string): void;
  pushTag(remote: string, tag: string): { ok: boolean; output: string };
  commitRelease(
    tag: string,
    trailers: string[],
    stable: boolean,
  ): Promise<{ commit: string; parent: string }>;
  pushMain(remote: string): { ok: boolean; output: string };
  remoteMain(): string;
}

export interface GitHubPort {
  pullRequests(sha: string): PullRequest[];
}

export function resolveIntent(labels: string[]): ReleaseIntent {
  const unique = [...new Set(labels)];
  if (unique.includes("release:skip")) return { release: false, kind: "skip" };
  const releaseLabels = unique.filter((label) => label.startsWith("release:"));
  if (!releaseLabels.length) return { release: true, kind: "rc", bump: "patch" };
  const unknown = releaseLabels.some(
    (label) => !/^release:(skip|patch|minor|major|rc)$/.test(label),
  );
  if (unknown || releaseLabels.includes("release:rc"))
    return { release: true, kind: "rc", bump: "patch" };
  if (releaseLabels.includes("release:major"))
    return { release: true, kind: "stable", bump: "major" };
  if (releaseLabels.includes("release:minor"))
    return { release: true, kind: "stable", bump: "minor" };
  return { release: true, kind: "stable", bump: "patch" };
}

export function resolveBatchIntent(commits: BatchCommit[]) {
  const covered: string[] = [];
  const skipped: string[] = [];
  let selected: { kind: "rc" | "stable"; bump: "patch" | "minor" | "major"; strength: number } = {
    kind: "rc",
    bump: "patch",
    strength: 0,
  };
  for (const commit of commits) {
    const intent = resolveIntent(commit.labels);
    if (commit.skipTrailer || !intent.release) {
      skipped.push(commit.sha);
      continue;
    }
    covered.push(commit.sha);
    const strength =
      intent.kind === "stable" ? { patch: 1, minor: 2, major: 3 }[intent.bump ?? "patch"] : 0;
    if (strength > selected.strength)
      selected = { kind: intent.kind as "rc" | "stable", bump: intent.bump ?? "patch", strength };
  }
  if (!covered.length) return { release: false as const, kind: "skip" as const, covered, skipped };
  return { release: true as const, kind: selected.kind, bump: selected.bump, covered, skipped };
}

function isReleaseBoundary(commit: HistoryCommit): boolean {
  const subjectTag = commit.subject.startsWith("release: ")
    ? commit.subject.slice("release: ".length)
    : "";
  return (
    (parseTag(subjectTag) !== null && commit.subject === releaseSubject(subjectTag)) ||
    commit.tags.some((tag) => parseTag(tag))
  );
}

export function uncoveredCommits(
  history: HistoryCommit[],
  workflowIntroduction: string | null,
): string[] {
  const boundary = history.findLastIndex(isReleaseBoundary);
  if (boundary >= 0) return history.slice(boundary + 1).map(({ sha }) => sha);
  if (!workflowIntroduction)
    throw new Error("No release boundary or workflow-introduction commit was found on main");
  const baseline = history.findIndex(({ sha }) => sha === workflowIntroduction);
  if (baseline < 0)
    throw new Error(
      `Workflow-introduction commit ${workflowIntroduction} is not on main first-parent history`,
    );
  return history.slice(baseline + 1).map(({ sha }) => sha);
}

export function selectPullRequest(
  sha: string,
  pullRequests: PullRequest[],
): { pullRequest: PullRequest; reason: string; rebaseMerge: boolean } {
  const merged = pullRequests.filter((pr) => pr.merged_at && pr.base.ref === "main");
  const exact = merged.filter((pr) => pr.merge_commit_sha === sha);
  const selected = exact.length ? exact : merged;
  if (selected.length !== 1)
    throw new Error(
      `Expected one merged PR for uncovered first-parent commit ${sha}; found ${selected.length}. Refusing to release without its labels.`,
    );
  const pullRequest = selected[0];
  return {
    pullRequest,
    reason: exact.length ? "exact merge SHA" : "merged PR fallback",
    rebaseMerge: Boolean(pullRequest.merge_commit_sha && pullRequest.merge_commit_sha !== sha),
  };
}

export function classifyPushFailure(
  output: string,
  remoteMain: string,
  expectedMain: string,
): "protection" | "race" {
  return remoteMain === expectedMain &&
    /GH013|protected branch|ruleset|permission denied|write access/i.test(output)
    ? "protection"
    : "race";
}

function hasSkipTrailer(message: string): boolean {
  return (
    message
      .trimEnd()
      .split(/\r?\n\r?\n/)
      .at(-1)
      ?.split(/\r?\n/)
      .includes("Release-Skip: true") ?? false
  );
}

export async function resolveBatch(git: GitPort, github: GitHubPort) {
  const history = git.firstParent();
  const hasBoundary = history.some(isReleaseBoundary);
  const shas = uncoveredCommits(history, hasBoundary ? null : git.workflowIntroduction());
  const commits: BatchCommit[] = [];
  for (const sha of shas) {
    const skipTrailer = hasSkipTrailer(git.message(sha));
    if (skipTrailer) {
      commits.push({ sha, labels: [], skipTrailer });
      continue;
    }
    const selection = selectPullRequest(sha, github.pullRequests(sha));
    if (selection.rebaseMerge) continue;
    commits.push({ sha, labels: selection.pullRequest.labels.map(({ name }) => name) });
  }
  return resolveBatchIntent(commits);
}

function compareTags(
  a: NonNullable<ReturnType<typeof parseTag>>,
  b: NonNullable<ReturnType<typeof parseTag>>,
) {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    (a.rc ?? Infinity) - (b.rc ?? Infinity)
  );
}
export function nextVersion(tags: string[], intent: ReleaseIntent): string {
  const parsed = tags.map(parseTag).filter((tag): tag is NonNullable<typeof tag> => tag !== null);
  const latestStable = parsed
    .filter((tag) => tag.rc === null)
    .sort(compareTags)
    .at(-1) ?? { major: 0, minor: 0, patch: 0 };
  if (intent.kind === "stable") {
    const next = { ...latestStable };
    if (intent.bump === "major") {
      next.major++;
      next.minor = 0;
      next.patch = 0;
    } else if (intent.bump === "minor") {
      next.minor++;
      next.patch = 0;
    } else next.patch++;
    return `v${next.major}.${next.minor}.${next.patch}`;
  }
  const base = { ...latestStable, patch: latestStable.patch + 1 };
  const collisions = parsed.filter(
    (tag) => tag.major === base.major && tag.minor === base.minor && tag.patch === base.patch,
  );
  const nextRc = Math.max(0, ...collisions.map((tag) => tag.rc ?? 0)) + 1;
  return `v${base.major}.${base.minor}.${base.patch}-rc.${nextRc}`;
}

export function promoteChangelog(text: string, version: string, date: string): string {
  const marker = "## [Unreleased]";
  const start = text.indexOf(marker);
  if (start < 0) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  const next = text.indexOf("\n## ", start + marker.length);
  const end = next < 0 ? text.length : next + 1;
  const section = text.slice(start + marker.length, next < 0 ? text.length : next);
  const body = section.replace(/^\s*\n/, "").replace(/\s*$/, "");
  const separator = next < 0 ? "\n" : "\n\n";
  return (
    text.slice(0, start) +
    `## [Unreleased]\n\n## [${version}] - ${date}${body ? `\n\n${body}` : ""}${separator}` +
    text.slice(end)
  );
}

function command(
  program: string,
  args: string[],
  allowFailure = false,
): { ok: boolean; output: string } {
  const result = spawnSync(program, args, { encoding: "utf8", env: process.env });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (!allowFailure && result.status !== 0)
    throw new Error(output || `${program} ${args.join(" ")} failed`);
  return { ok: result.status === 0, output };
}
function gitText(args: string[]) {
  return command("git", args).output;
}

class CommandGit implements GitPort {
  private triggerSha: string;
  constructor(triggerSha: string) {
    this.triggerSha = triggerSha;
  }
  fetchMain() {
    command("git", ["fetch", "origin", "main", "--force", "--tags"]);
    command("git", ["checkout", "-B", "main", "origin/main"]);
    command("git", ["cat-file", "-e", `${this.triggerSha}^{commit}`]);
    if (!command("git", ["merge-base", "--is-ancestor", this.triggerSha, "HEAD"], true).ok)
      throw new Error(
        `Trigger ${this.triggerSha} is not an ancestor of current main ${gitText(["rev-parse", "HEAD"])}`,
      );
  }
  firstParent() {
    return gitText(["rev-list", "--first-parent", "--reverse", "origin/main"])
      .split("\n")
      .filter(Boolean)
      .map((sha) => ({
        sha,
        subject: gitText(["show", "-s", "--format=%s", sha]),
        tags: gitText(["tag", "--points-at", sha, "v*"]).split("\n").filter(Boolean),
      }));
  }
  workflowIntroduction() {
    return (
      gitText([
        "log",
        "--first-parent",
        "--reverse",
        "--diff-filter=A",
        "--format=%H",
        "origin/main",
        "--",
        ".github/workflows/release-on-merge.yml",
      ])
        .split("\n")
        .filter(Boolean)[0] ?? null
    );
  }
  message(sha: string) {
    return gitText(["show", "-s", "--format=%B", sha]);
  }
  tags() {
    return gitText(["tag", "--list", "v*"]).split("\n").filter(Boolean);
  }
  tagCommit(tag: string) {
    const peeled =
      command("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}^{}`]).output ||
      command("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).output;
    return peeled.split(/\s/)[0] || null;
  }
  createTag(tag: string, commit: string) {
    command("git", ["tag", "-a", tag, commit, "-m", `Release ${tag.slice(1)}`]);
  }
  pushTag(remote: string, tag: string) {
    return command("git", ["push", remote, `refs/tags/${tag}`], true);
  }
  async commitRelease(tag: string, trailers: string[], stable: boolean) {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    pkg.version = tag.slice(1);
    await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
    if (stable)
      await writeFile(
        "CHANGELOG.md",
        promoteChangelog(
          await readFile("CHANGELOG.md", "utf8"),
          tag.slice(1),
          new Date().toISOString().slice(0, 10),
        ),
      );
    command("git", ["add", "package.json", ...(stable ? ["CHANGELOG.md"] : [])]);
    command("git", [
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "-m",
      releaseSubject(tag),
      "-m",
      trailers.join("\n"),
    ]);
    return { commit: gitText(["rev-parse", "HEAD"]), parent: gitText(["rev-parse", "HEAD^"]) };
  }
  pushMain(remote: string) {
    return command("git", ["push", remote, "HEAD:main"], true);
  }
  remoteMain() {
    command("git", ["fetch", "origin", "main", "--force", "--tags"]);
    return gitText(["rev-parse", "origin/main"]);
  }
}
class CommandGitHub implements GitHubPort {
  private repository: string;
  constructor(repository: string) {
    this.repository = repository;
  }
  pullRequests(sha: string) {
    return JSON.parse(
      command("gh", ["api", `/repos/${this.repository}/commits/${sha}/pulls`]).output,
    ) as PullRequest[];
  }
}

function priorRelease(git: GitPort, triggerSha: string) {
  for (const commit of git.firstParent().toReversed()) {
    const tag = commit.subject.startsWith("release: ") ? commit.subject.slice(9) : "";
    if (
      parseTag(tag) &&
      git.message(commit.sha).split(/\r?\n/).includes(`Release-Trigger: ${triggerSha}`)
    )
      return { tag, commit: commit.sha };
  }
  return null;
}
function releaseRemote(repository: string): string {
  const token = process.env.RELEASE_TOKEN;
  if (!token)
    throw new Error(
      "Missing RELEASE_TOKEN. Configure a ruleset-bypass release credential; see docs/deploy/runbook.md.",
    );
  return (
    process.env.RELEASE_REMOTE_URL ?? `https://x-access-token:${token}@github.com/${repository}.git`
  );
}
function ensureTag(git: GitPort, remote: string, tag: string, commit: string) {
  const existing = git.tagCommit(tag);
  if (existing && existing !== commit)
    throw new Error(`Tag ${tag} already points to ${existing}, expected ${commit}`);
  if (existing) return;
  git.createTag(tag, commit);
  const pushed = git.pushTag(remote, tag);
  if (!pushed.ok && git.tagCommit(tag) !== commit)
    throw new Error(pushed.output || `Could not push ${tag}`);
}

export async function publish(
  git: GitPort,
  github: GitHubPort,
  triggerSha: string,
  repository: string,
) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    git.fetchMain();
    const prior = priorRelease(git, triggerSha);
    if (prior) {
      ensureTag(git, releaseRemote(repository), prior.tag, prior.commit);
      return prior.tag;
    }
    const batch = await resolveBatch(git, github);
    console.log(`::notice::Resolved release batch: ${JSON.stringify(batch)}.`);
    if (!batch.release) {
      console.log(
        "::notice::Current main batch contains no release-worthy merges; no release created.",
      );
      return null;
    }
    const remote = releaseRemote(repository);
    const tag = nextVersion(git.tags(), batch);
    if (git.tagCommit(tag))
      throw new Error(`Computed tag ${tag} already exists but has no matching release trigger`);
    const release = await git.commitRelease(
      tag,
      batch.covered.map((sha) => `Release-Trigger: ${sha}`),
      batch.kind === "stable",
    );
    const pushed = git.pushMain(remote);
    if (pushed.ok) {
      ensureTag(git, remote, tag, release.commit);
      return tag;
    }
    const classification = classifyPushFailure(pushed.output, git.remoteMain(), release.parent);
    if (classification === "protection")
      throw new Error(
        "RELEASE_TOKEN was rejected by main protection. Its owner must bypass the protect ruleset; see docs/deploy/runbook.md.",
      );
    if (attempt === 3) throw new Error("Release push lost three races; rerun the workflow.");
  }
  return null;
}

async function main() {
  if (process.argv[2] !== "run") throw new Error("Usage: release.ts run");
  const triggerSha = process.env.TRIGGER_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!triggerSha || !repository) throw new Error("TRIGGER_SHA and GITHUB_REPOSITORY are required");
  const tag = await publish(
    new CommandGit(triggerSha),
    new CommandGitHub(repository),
    triggerSha,
    repository,
  );
  if (tag) console.log(`Released ${tag}`);
}
if (process.argv[1]?.endsWith("release.ts"))
  main().catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
