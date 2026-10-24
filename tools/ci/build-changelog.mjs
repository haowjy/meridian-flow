#!/usr/bin/env node
/**
 * Build a changelog from paged GitHub results or saved pull request bodies.
 * A malformed section fails the whole build and names its PR; consumers must
 * check the exit status rather than accept a silently incomplete changelog.
 * Interactive Markdown uses $PAGER or less -FRX; JSON and redirected output do not.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parsePrChangelog } from "./pr-changelog.mjs";

const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const PULL_REQUESTS_QUERY = `
query ChangelogPullRequests($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      first: ${PAGE_SIZE}
      after: $cursor
      states: MERGED
      baseRefName: "main"
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        number
        title
        mergedAt
        updatedAt
        baseRefName
        body
        url
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

function usage() {
  return `usage: pnpm changelog [-- --since <YYYY-MM-DD | N.days> | --all] [--json] [--no-pager] [--input <file>]

Build the changelog from pull requests merged into main. GitHub results are fetched 50 at a time.
The default range is 30 days; --all follows every GitHub results page.
Markdown is sent through $PAGER (or less -FRX) when stdout is a terminal; use --no-pager to print directly.
Malformed Changelog sections stop the build and name the PR; always check the exit status.`;
}

function parseArguments(argv, now) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let input;
  let json = false;
  let noPager = false;
  let all = false;
  let since;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--json") {
      if (json) throw new Error("--json may be given only once");
      json = true;
    } else if (argument === "--no-pager") {
      if (noPager) throw new Error("--no-pager may be given only once");
      noPager = true;
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
    noPager,
    cutoff: all ? null : parseCutoff(since ?? "30.days", now),
  };
}

function writeOutput(output, { format, noPager }) {
  if (!output || format === "json" || noPager || !process.stdout.isTTY) {
    process.stdout.write(output);
    return;
  }

  const customPager = process.env.PAGER?.trim();
  const result = customPager
    ? spawnSync(process.env.SHELL || "/bin/sh", ["-c", customPager], {
        input: output,
        stdio: ["pipe", "inherit", "ignore"],
      })
    : spawnSync("less", ["-FRX"], {
        input: output,
        stdio: ["pipe", "inherit", "ignore"],
      });

  // A missing or unstartable pager must not make changelog output unavailable.
  if (result.error?.code === "ENOENT" || result.status === 126 || result.status === 127) {
    process.stdout.write(output);
  }
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

function parseJson(json, source) {
  let value;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  return value;
}

function parsePullRequests(json, source) {
  const value = parseJson(json, source);
  if (!Array.isArray(value)) throw new Error(`${source} must contain a JSON array`);
  return value;
}

function rateLimitAdvice(detail) {
  return /rate.?limit/i.test(detail)
    ? "\nCheck the reset time with gh api rate_limit, then retry after the limit resets."
    : "";
}

function readGitHubPage(cursor) {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${PULL_REQUESTS_QUERY}`,
    "-F",
    "owner={owner}",
    "-F",
    "name={repo}",
  ];
  if (cursor !== undefined) args.push("-F", `cursor=${cursor}`);

  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("GitHub CLI (gh) is not installed; install it, then run gh auth login");
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `GitHub CLI could not list merged PRs; run gh auth login and try again${detail ? `\n${detail}` : ""}${rateLimitAdvice(detail)}`,
    );
  }

  const response = parseJson(result.stdout, "gh output");
  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    const details = response.errors
      .map((error) => (typeof error?.message === "string" ? error.message : JSON.stringify(error)))
      .join("; ");
    throw new Error(`GitHub GraphQL returned errors: ${details}${rateLimitAdvice(details)}`);
  }
  const connection = response?.data?.repository?.pullRequests;
  if (!Array.isArray(connection?.nodes)) {
    throw new Error("GitHub GraphQL response is missing pull request nodes");
  }
  if (typeof connection.pageInfo?.hasNextPage !== "boolean") {
    throw new Error("GitHub GraphQL response has invalid page information");
  }
  if (connection.pageInfo.hasNextPage && typeof connection.pageInfo.endCursor !== "string") {
    throw new Error("GitHub GraphQL response is missing the next page cursor");
  }
  return connection;
}

export function entriesFromPullRequests(prs, cutoff) {
  const included = prs
    .filter((pr) => pr?.baseRefName === "main")
    .filter((pr) => {
      if (typeof pr.mergedAt !== "string" || Number.isNaN(Date.parse(pr.mergedAt))) {
        throw new Error(`PR #${pr?.number ?? "?"} has an invalid mergedAt value`);
      }
      return cutoff === null || Date.parse(pr.mergedAt) >= cutoff.valueOf();
    });

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

function readChangelogEntriesFromGitHub(cutoff) {
  const entries = [];
  let cursor;

  while (true) {
    const page = readGitHubPage(cursor);
    const pageEntries = entriesFromPullRequests(page.nodes, cutoff);
    for (const entry of pageEntries) entries.push(entry);

    const updatedTimes = page.nodes.map((pr) => {
      if (typeof pr?.updatedAt !== "string" || Number.isNaN(Date.parse(pr.updatedAt))) {
        throw new Error(`PR #${pr?.number ?? "?"} has an invalid updatedAt value`);
      }
      return Date.parse(pr.updatedAt);
    });
    const oldestUpdatedAt = Math.min(...updatedTimes);
    // GitHub orders pages by updatedAt descending, and updatedAt is never earlier than
    // mergedAt. Once a page crosses the cutoff, no later page can contain an in-range merge.
    if (cutoff !== null && oldestUpdatedAt < cutoff.valueOf()) break;
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return entries;
}

export function formatChangelog(entries, format) {
  const sortedEntries = entries.toSorted(
    (left, right) =>
      Date.parse(right.mergedAt) - Date.parse(left.mergedAt) || right.number - left.number,
  );
  if (format === "json") return `${JSON.stringify(sortedEntries, null, 2)}\n`;
  if (format !== "markdown") throw new Error(`unknown output format: ${format}`);

  const lines = [];
  let currentDate;
  for (const entry of sortedEntries) {
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
      const entries = options.input
        ? entriesFromPullRequests(
            parsePullRequests(readFileSync(options.input, "utf8"), options.input),
            options.cutoff,
          )
        : readChangelogEntriesFromGitHub(options.cutoff);
      const output = formatChangelog(entries, options.format);
      writeOutput(output, options);
    }
  } catch (error) {
    console.error(`changelog: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
  }
}
