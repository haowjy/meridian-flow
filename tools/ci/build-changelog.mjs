#!/usr/bin/env node
/**
 * Build a changelog from structured sections in merged pull request bodies.
 * A malformed section fails the whole build and names its PR; consumers must
 * check the exit status rather than accept a silently incomplete changelog.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parsePrChangelog } from "./pr-changelog.mjs";

const LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GH_FIELDS = "number,title,mergedAt,baseRefName,body,url";

function usage() {
  return `usage: pnpm changelog [-- --since <YYYY-MM-DD | N.days> | --all] [--json] [--input <file>]

Build the changelog from pull requests merged into main. The default range is 30 days.
Malformed Changelog sections stop the build and name the PR; always check the exit status.`;
}

function parseArguments(argv, now) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let input;
  let json = false;
  let all = false;
  let since;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--json") {
      if (json) throw new Error("--json may be given only once");
      json = true;
    } else if (argument === "--all") {
      if (all) throw new Error("--all may be given only once");
      all = true;
    } else if (argument === "--since" || argument === "--input") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      index += 1;
      if (argument === "--since") {
        if (since !== undefined) throw new Error("--since may be given only once");
        since = value;
      } else {
        if (input !== undefined) throw new Error("--input may be given only once");
        input = value;
      }
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }

  if (all && since !== undefined) throw new Error("--all and --since cannot be used together");
  return {
    help: false,
    input,
    format: json ? "json" : "markdown",
    cutoff: all ? null : parseCutoff(since ?? "30.days", now),
  };
}

function parseCutoff(value, now) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const cutoff = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(cutoff.valueOf()) || cutoff.toISOString().slice(0, 10) !== value) {
      throw new Error(`invalid --since date: ${value}`);
    }
    return cutoff;
  }

  const relative = /^(\d+)\.days$/.exec(value);
  if (relative) {
    const cutoff = new Date(now.valueOf() - Number(relative[1]) * DAY_MS);
    if (Number.isNaN(cutoff.valueOf())) {
      throw new Error(
        `invalid --since value: ${value}; relative date is outside the supported range`,
      );
    }
    return cutoff;
  }
  throw new Error(`invalid --since value: ${value}; use YYYY-MM-DD or N.days`);
}

function parsePullRequests(json, source) {
  let value;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(value)) throw new Error(`${source} must contain a JSON array`);
  return value;
}

function readPullRequestsFromGitHub() {
  const result = spawnSync(
    "gh",
    ["pr", "list", "--state", "merged", "--limit", String(LIMIT), "--json", GH_FIELDS],
    { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
  if (result.error?.code === "ENOENT") {
    throw new Error("GitHub CLI (gh) is not installed; install it, then run gh auth login");
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `GitHub CLI could not list merged PRs; run gh auth login and try again${detail ? `\n${detail}` : ""}`,
    );
  }

  const prs = parsePullRequests(result.stdout, "gh output");
  if (prs.length === LIMIT) {
    console.error(`warning: gh returned the ${LIMIT}-PR limit; older matching entries are omitted`);
  }
  return prs;
}

function changelogEntries(prs, cutoff) {
  const included = prs
    .filter((pr) => pr?.baseRefName === "main")
    .filter((pr) => {
      if (typeof pr.mergedAt !== "string" || Number.isNaN(Date.parse(pr.mergedAt))) {
        throw new Error(`PR #${pr?.number ?? "?"} has an invalid mergedAt value`);
      }
      return cutoff === null || Date.parse(pr.mergedAt) >= cutoff.valueOf();
    })
    .sort(
      (left, right) =>
        Date.parse(right.mergedAt) - Date.parse(left.mergedAt) || right.number - left.number,
    );

  return included.flatMap((pr) => {
    const parsed = parsePrChangelog(typeof pr.body === "string" ? pr.body : "");
    if (parsed.kind === "missing" || parsed.kind === "none") return [];
    if (parsed.kind === "invalid") {
      const source = typeof pr.url === "string" ? ` (${pr.url})` : "";
      throw new Error(
        `PR #${pr.number}${source} has an invalid Changelog section: ${parsed.reason}`,
      );
    }
    if (
      !Number.isInteger(pr.number) ||
      typeof pr.title !== "string" ||
      typeof pr.url !== "string"
    ) {
      throw new Error("each included PR needs number, title, mergedAt, body, and url fields");
    }

    const date = new Date(pr.mergedAt).toISOString().slice(0, 10);
    return parsed.entries.map((entry) => ({
      date,
      category: entry.category,
      text: entry.text,
      number: pr.number,
      title: pr.title,
      mergedAt: pr.mergedAt,
      url: pr.url,
    }));
  });
}

/** Pure transformation used by both live GitHub and offline fixture paths. */
export function buildChangelog(prs, { cutoff, format }) {
  const entries = changelogEntries(prs, cutoff);
  if (format === "json") return `${JSON.stringify(entries, null, 2)}\n`;
  if (format !== "markdown") throw new Error(`unknown output format: ${format}`);

  const lines = [];
  let currentDate;
  for (const entry of entries) {
    if (entry.date !== currentDate) {
      if (lines.length > 0) lines.push("");
      lines.push(`## ${entry.date}`, "");
      currentDate = entry.date;
    }
    lines.push(`- ${entry.category}: ${entry.text} ([#${entry.number}](${entry.url}))`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2), new Date());
    if (options.help) {
      console.log(usage());
    } else {
      const prs = options.input
        ? parsePullRequests(readFileSync(options.input, "utf8"), options.input)
        : readPullRequestsFromGitHub();
      process.stdout.write(buildChangelog(prs, options));
    }
  } catch (error) {
    console.error(`changelog: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
  }
}
