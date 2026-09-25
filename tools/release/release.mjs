#!/usr/bin/env node
// Pure release policy plus small file operations shared by CI and local dry-runs.
import { readFile, writeFile } from "node:fs/promises";

const stable = /^v(\d+)\.(\d+)\.(\d+)$/;
const rc = /^v(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/;

export function resolveIntent(labels) {
  const unique = [...new Set(labels)];
  if (unique.includes("release:skip")) return { release: false, kind: "skip" };
  const rel = unique.filter((label) => label.startsWith("release:"));
  if (!rel.length) return { release: true, kind: "rc", bump: "patch" };
  const unknown = rel.some((label) => !/^release:(skip|patch|stable|minor|major|rc)$/.test(label));
  if (unknown || rel.includes("release:rc")) return { release: true, kind: "rc", bump: "patch" };
  if (rel.includes("release:major")) return { release: true, kind: "stable", bump: "major" };
  if (rel.includes("release:minor")) return { release: true, kind: "stable", bump: "minor" };
  if (rel.some((label) => ["release:patch", "release:stable"].includes(label)))
    return { release: true, kind: "stable", bump: "patch" };
  return { release: true, kind: "rc", bump: "patch" };
}

function parseTag(tag) {
  const match = tag.match(stable) ?? tag.match(rc);
  if (!match) return null;
  return {
    major: +match[1],
    minor: +match[2],
    patch: +match[3],
    rc: match[4] ? +match[4] : null,
    tag,
  };
}
function cmp(a, b) {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    (a.rc ?? Infinity) - (b.rc ?? Infinity)
  );
}
function format(v, suffix = "") {
  return `v${v.major}.${v.minor}.${v.patch}${suffix}`;
}

export function nextVersion(tags, intent) {
  const parsed = tags.map(parseTag).filter(Boolean);
  const stableTags = parsed.filter((v) => v.rc === null).sort(cmp);
  const latestStable = stableTags.at(-1) ?? { major: 0, minor: 0, patch: 0 };
  if (intent.kind === "stable") {
    const next = { ...latestStable, rc: null };
    if (intent.bump === "major") {
      next.major++;
      next.minor = 0;
      next.patch = 0;
    } else if (intent.bump === "minor") {
      next.minor++;
      next.patch = 0;
    } else next.patch++;
    // A stable version is never silently reused, even if an old tag is malformed in history.
    return format(next);
  }
  const base = { ...latestStable, patch: latestStable.patch + 1, rc: null };
  const collisions = parsed.filter(
    (v) => v.major === base.major && v.minor === base.minor && v.patch === base.patch,
  );
  const nextRc = Math.max(0, ...collisions.map((v) => v.rc ?? 0)) + 1;
  return format(base, `-rc.${nextRc}`);
}

export function promoteChangelog(text, version, date) {
  const marker = "## [Unreleased]";
  const start = text.indexOf(marker);
  if (start < 0) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  const next = text.indexOf("\n## ", start + marker.length);
  const end = next < 0 ? text.length : next + 1;
  const section = text.slice(start + marker.length, next < 0 ? text.length : next);
  const body = section.replace(/^\s*\n/, "").replace(/\s*$/, "");
  const separator = next < 0 ? "\n" : "\n\n";
  const rolled = `## [Unreleased]\n\n## [${version}] - ${date}${body ? `\n\n${body}` : ""}${separator}`;
  return text.slice(0, start) + rolled + text.slice(end);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "intent") console.log(JSON.stringify(resolveIntent(JSON.parse(args[0] ?? "[]"))));
  else if (command === "version")
    console.log(nextVersion(JSON.parse(args[0] ?? "[]"), JSON.parse(args[1] ?? "{}")));
  else if (command === "bump") {
    const path = args[0] ?? "package.json";
    const version = args[1];
    const pkg = JSON.parse(await readFile(path, "utf8"));
    pkg.version = version;
    await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
  } else if (command === "changelog") {
    const [path, version, date] = args;
    await writeFile(path, promoteChangelog(await readFile(path, "utf8"), version, date));
  } else
    throw new Error(
      "Usage: release.mjs intent <labels-json> | version <tags-json> <intent-json> | bump <package.json> <version> | changelog <file> <version> <date>",
    );
}
if (process.argv[1]?.endsWith("/release.mjs"))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
