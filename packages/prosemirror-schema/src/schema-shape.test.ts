/** Append-only history and bump-class gate for the collaboration schema surface. */
import { execFileSync } from "node:child_process";
import type { Attrs, MarkSpec, NodeSpec } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  documentMarks,
  documentNodes,
  PROSEMIRROR_FRAGMENT_NAME,
} from "./index.js";
import versionHistory from "./schema-shape.history.json";

const POLICY = "packages/prosemirror-schema/AGENTS.md#schema-version-bump-policy";
const HISTORY_PATH = "packages/prosemirror-schema/src/schema-shape.history.json";
const PREDECESSOR_PATH = "packages/prosemirror-schema/src/schema-shape.snapshot.json";

type AttributeSurface = {
  hasDefault: boolean;
  default?: unknown;
};

type TypeSurface = {
  attrs: Record<string, AttributeSurface>;
  content: string | null;
};

type SchemaSurface = {
  fragmentName: string;
  nodes: Record<string, TypeSurface>;
  marks: Record<string, TypeSurface>;
};

type SchemaShapeHistoryEntry = {
  version: CollabSchemaVersion;
  surface: SchemaSurface;
};

type BumpClass = "none" | "addition" | "mutation" | "major";

function attributeSurface(attrs: Attrs | undefined): Record<string, AttributeSurface> {
  return Object.fromEntries(
    Object.entries(attrs ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, spec]) => [
        name,
        "default" in spec ? { hasDefault: true, default: spec.default } : { hasDefault: false },
      ]),
  );
}

function typeSurface(specs: Record<string, NodeSpec | MarkSpec>): Record<string, TypeSurface> {
  return Object.fromEntries(
    Object.entries(specs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, spec]) => [
        name,
        {
          attrs: attributeSurface(spec.attrs),
          content: "content" in spec ? (spec.content ?? null) : null,
        },
      ]),
  );
}

function currentSurface(): SchemaSurface {
  return {
    fragmentName: PROSEMIRROR_FRAGMENT_NAME,
    nodes: typeSurface(documentNodes),
    marks: typeSurface(documentMarks),
  };
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function classifyTypeMap(
  previous: Record<string, TypeSurface>,
  current: Record<string, TypeSurface>,
): BumpClass {
  let result: BumpClass = "none";
  for (const [name, previousType] of Object.entries(previous)) {
    const currentType = current[name];
    if (!currentType) return "major";
    if (previousType.content !== currentType.content) result = maxBump(result, "mutation");
    for (const [attrName, previousAttr] of Object.entries(previousType.attrs)) {
      const currentAttr = currentType.attrs[attrName];
      if (!currentAttr) return "major";
      if (!equal(previousAttr, currentAttr)) result = maxBump(result, "mutation");
    }
    for (const [attrName, currentAttr] of Object.entries(currentType.attrs)) {
      if (attrName in previousType.attrs) continue;
      if (!currentAttr.hasDefault) return "major";
      result = maxBump(result, "addition");
    }
  }
  if (Object.keys(current).some((name) => !(name in previous))) {
    result = maxBump(result, "addition");
  }
  return result;
}

function maxBump(a: BumpClass, b: BumpClass): BumpClass {
  if (a === "major" || b === "major") return "major";
  if (a === "mutation" || b === "mutation") return "mutation";
  if (a === "addition" || b === "addition") return "addition";
  return "none";
}

function classifySurfaceChange(previous: SchemaSurface, current: SchemaSurface): BumpClass {
  if (previous.fragmentName !== current.fragmentName) return "major";
  return maxBump(
    classifyTypeMap(previous.nodes, current.nodes),
    classifyTypeMap(previous.marks, current.marks),
  );
}

function validateBump(
  previous: CollabSchemaVersion,
  current: CollabSchemaVersion,
  bump: BumpClass,
): void {
  if (bump === "none") {
    const unchanged = equal(previous, current);
    const nextPatch =
      current.major === previous.major &&
      current.minor === previous.minor &&
      current.patch === previous.patch + 1;
    if (!unchanged && !nextPatch) {
      throw new Error(
        "An identical schema surface permits only an unchanged version or the next patch.",
      );
    }
    return;
  }
  const nextMinor =
    current.major === previous.major && current.minor === previous.minor + 1 && current.patch === 0;
  if (bump === "addition") {
    if (!nextMinor) {
      throw new Error("Additive schema surface changes require an x.(y+1).0 version bump.");
    }
    return;
  }
  const nextMajor =
    current.major === previous.major + 1 && current.minor === 0 && current.patch === 0;
  if (bump === "mutation") {
    if (!nextMinor && !nextMajor) {
      throw new Error("Schema surface mutations require an x.(y+1).0 or (x+1).0.0 version bump.");
    }
    return;
  }
  if (!nextMajor) {
    throw new Error(
      `Removing or renaming schema surface, changing the fragment name, or changing Yjs encoding requires a major bump, human ruling, and migration plan. See ${POLICY}.`,
    );
  }
}

const history = versionHistory as SchemaShapeHistoryEntry[];
const baseline = history[history.length - 1];

if (!baseline) {
  throw new Error("The collaboration schema version history must contain an initial entry.");
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function historyAt(reference: string): SchemaShapeHistoryEntry[] | null {
  try {
    return JSON.parse(git("show", `${reference}:${HISTORY_PATH}`)) as SchemaShapeHistoryEntry[];
  } catch {
    return null;
  }
}

function predecessorSnapshot(): SchemaShapeHistoryEntry {
  const deletion = git(
    "log",
    "--full-history",
    "-1",
    "--format=%H",
    "--diff-filter=D",
    "--",
    `:(top)${PREDECESSOR_PATH}`,
  );
  if (!deletion) {
    throw new Error(`Cannot locate the immutable predecessor ${PREDECESSOR_PATH}.`);
  }
  try {
    return JSON.parse(git("show", `${deletion}^:${PREDECESSOR_PATH}`)) as SchemaShapeHistoryEntry;
  } catch {
    throw new Error(`Cannot read the immutable predecessor ${PREDECESSOR_PATH}.`);
  }
}

function baseReference(): string | null {
  if (process.env.GITHUB_EVENT_NAME === "pull_request") return "HEAD^1";
  try {
    return git("merge-base", "HEAD", "origin/main");
  } catch {
    return null;
  }
}

function expectHistoryPrefix(reference: string): boolean {
  const previous = historyAt(reference);
  if (!previous) return false;
  expect(
    history.slice(0, previous.length),
    `Existing collaboration schema history entries from ${reference} are immutable; append a new entry instead.`,
  ).toEqual(previous);
  return true;
}

describe("collaboration schema shape", () => {
  it("only appends to committed version history", () => {
    if (!expectHistoryPrefix("HEAD")) {
      throw new Error(`Cannot read committed collaboration schema history from ${HISTORY_PATH}.`);
    }
    const base = baseReference();
    if (!base || base === git("rev-parse", "HEAD")) return;
    if (!expectHistoryPrefix(base)) {
      expect(history[0], "The initial history entry must match its immutable predecessor.").toEqual(
        predecessorSnapshot(),
      );
    }
  });

  it("preserves valid transitions in the append-only version history", () => {
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1];
      const current = history[index];
      const bump = classifySurfaceChange(previous.surface, current.surface);
      validateBump(previous.version, current.version, bump);
    }
  });

  it("matches the latest recorded surface and version", () => {
    expect(currentSurface()).toEqual(baseline.surface);
    expect(COLLAB_SCHEMA_VERSION).toEqual(baseline.version);
  });

  it("permits an identical surface without a bump", () => {
    expect(classifySurfaceChange(baseline.surface, baseline.surface)).toBe("none");
    expect(() => validateBump(baseline.version, baseline.version, "none")).not.toThrow();
  });

  it("requires a minor bump for a new type or defaulted attribute", () => {
    const addedType: SchemaSurface = structuredClone(baseline.surface);
    addedType.nodes.callout = { attrs: {}, content: "block+" };
    expect(classifySurfaceChange(baseline.surface, addedType)).toBe("addition");

    const addedAttr: SchemaSurface = structuredClone(baseline.surface);
    addedAttr.nodes.paragraph.attrs.variant = { hasDefault: true, default: null };
    expect(classifySurfaceChange(baseline.surface, addedAttr)).toBe("addition");
    expect(() =>
      validateBump(
        baseline.version,
        { major: baseline.version.major, minor: baseline.version.minor + 1, patch: 0 },
        "addition",
      ),
    ).not.toThrow();
    expect(() => validateBump(baseline.version, baseline.version, "addition")).toThrow("x.(y+1).0");
    expect(() =>
      validateBump(
        baseline.version,
        { major: baseline.version.major + 1, minor: 0, patch: 0 },
        "addition",
      ),
    ).toThrow("x.(y+1).0");
  });

  it("accepts the next minor or next major for content and default mutations", () => {
    const contentChanged: SchemaSurface = structuredClone(baseline.surface);
    contentChanged.nodes.paragraph.content = "inline+";
    expect(classifySurfaceChange(baseline.surface, contentChanged)).toBe("mutation");

    const defaultChanged: SchemaSurface = structuredClone(baseline.surface);
    defaultChanged.nodes.heading.attrs.level.default = 2;
    expect(classifySurfaceChange(baseline.surface, defaultChanged)).toBe("mutation");
    expect(() => validateBump(baseline.version, baseline.version, "mutation")).toThrow(
      "x.(y+1).0 or (x+1).0.0",
    );
    expect(() =>
      validateBump(
        baseline.version,
        { major: baseline.version.major, minor: baseline.version.minor + 1, patch: 0 },
        "mutation",
      ),
    ).not.toThrow();
    expect(() =>
      validateBump(
        baseline.version,
        { major: baseline.version.major + 1, minor: 0, patch: 0 },
        "mutation",
      ),
    ).not.toThrow();
  });

  it.each([
    "node",
    "mark",
    "attribute",
    "fragment",
  ] as const)("hard-fails a removed or renamed %s without a policy-linked major bump", (kind) => {
    const changed: SchemaSurface = structuredClone(baseline.surface);
    if (kind === "node") delete changed.nodes.paragraph;
    if (kind === "mark") delete changed.marks.strong;
    if (kind === "attribute") delete changed.nodes.heading.attrs.level;
    if (kind === "fragment") changed.fragmentName = "renamed";

    expect(classifySurfaceChange(baseline.surface, changed)).toBe("major");
    expect(() => validateBump(baseline.version, baseline.version, "major")).toThrow(POLICY);
    expect(() =>
      validateBump(
        baseline.version,
        { major: baseline.version.major + 1, minor: 0, patch: 0 },
        "major",
      ),
    ).not.toThrow();
  });
});
