/**
 * Mars version constraint parsing and tag selection.
 *
 * Keeps mars-agents compatibility rules in a small functional core so package
 * install never confuses a semantic version constraint with a git ref.
 */
import * as semver from "semver";

export type MarsVersionConstraint =
  | { kind: "latest"; raw: string | null }
  | { kind: "version"; raw: string; range: string }
  | { kind: "ref"; raw: string; ref: string };

export interface MarsVersionTag {
  tag: string;
  version: string;
}

export function parseMarsVersionConstraint(
  input: string | null | undefined,
): MarsVersionConstraint {
  const raw = input?.trim() ?? "";
  if (!raw || raw === "latest") {
    return { kind: "latest", raw: input ?? null };
  }

  const exact = semver.valid(raw);
  if (exact) {
    return { kind: "version", raw, range: `=${exact}` };
  }

  const shorthand = parseMarsVersionShorthand(raw);
  if (shorthand) {
    return { kind: "version", raw, range: shorthand };
  }

  const npmRange = raw.replaceAll(",", " ");
  const range = semver.validRange(npmRange);
  if (range) {
    return { kind: "version", raw, range };
  }

  return { kind: "ref", raw, ref: raw };
}

export function parseSemverTags(tags: string[]): MarsVersionTag[] {
  return tags
    .flatMap((tag) => {
      const version = semver.valid(tag);
      return version ? [{ tag, version }] : [];
    })
    .sort((a, b) => semver.compare(a.version, b.version));
}

export function selectNewestSatisfyingTag(
  tags: MarsVersionTag[],
  constraint: MarsVersionConstraint,
): MarsVersionTag | null {
  if (constraint.kind === "ref") return null;
  const range = constraint.kind === "latest" ? "*" : constraint.range;
  return (
    tags
      .filter((tag) => semver.satisfies(tag.version, range, { includePrerelease: true }))
      .sort((a, b) => semver.rcompare(a.version, b.version))[0] ?? null
  );
}

export function versionConstraintLabel(constraint: MarsVersionConstraint): string {
  if (constraint.kind === "latest") return "latest";
  return constraint.raw;
}

function parseMarsVersionShorthand(raw: string): string | null {
  const major = /^v?(\d+)$/.exec(raw);
  if (major) {
    const majorNumber = Number(major[1]);
    return `>=${majorNumber}.0.0 <${majorNumber + 1}.0.0`;
  }

  const minor = /^v?(\d+)\.(\d+)$/.exec(raw);
  if (minor) {
    const majorNumber = Number(minor[1]);
    const minorNumber = Number(minor[2]);
    return `>=${majorNumber}.${minorNumber}.0 <${majorNumber}.${minorNumber + 1}.0`;
  }

  return null;
}
