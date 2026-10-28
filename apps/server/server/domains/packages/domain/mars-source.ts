/**
 * Mars file-format parsers: mars.toml, markdown frontmatter, and the canonical
 * JSON form used for digests.
 */
import { parse as parseToml } from "smol-toml";
import YAML from "yaml";

import { objectAt, stringAt } from "./helpers.js";
import type { AgentConfigOverlay, JsonObject, PackageVisibility, ParsedMarsToml } from "./types.js";

export function parseMarsToml(
  source: string,
  options: { packageNameFallback?: string } = {},
): ParsedMarsToml {
  const parsed = parseToml(source) as JsonObject;
  const packageSection = objectAt(parsed.package);
  // Fall back to the directory name when `package.name` is absent — this
  // happens when a package is being imported from a directory whose name
  // doubles as the package identity.
  const packageName = stringAt(packageSection.name) ?? options.packageNameFallback;
  if (!packageName) {
    throw new Error("mars.toml is missing package.name");
  }

  const version = stringAt(packageSection.version);
  const description = stringAt(packageSection.description);
  const visibility = packageVisibilityAt(packageSection.visibility);

  return {
    package: {
      name: packageName,
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
      ...(visibility ? { visibility } : {}),
    },
    agentOverlays: readAgentOverlays(parsed.agents),
  };
}

export function parseMarkdownDefinition(raw: string): { meta: JsonObject; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new Error("Markdown definition is missing YAML frontmatter");
  }
  const document = YAML.parse(match[1]);
  if (document !== null && (typeof document !== "object" || Array.isArray(document))) {
    throw new Error("Markdown definition frontmatter must be a YAML mapping");
  }
  const meta = objectAt(document);
  const body = raw.slice(match[0].length).replace(/^\r?\n/, "");
  return { meta, body };
}

/** Canonical JSON object for checksum stability — keys sorted recursively. */
export function canonicalizeJsonObject(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJsonValue(value[key])]),
  );
}

/**
 * Recursively canonicalize any JSON value — objects get sorted keys, arrays
 * keep their order but canonicalize their elements. Arrays must be descended
 * into because Postgres jsonb scrambles key order of objects nested inside
 * them just like top-level objects.
 */
function canonicalizeJsonValue(entry: JsonObject[string]): JsonObject[string] {
  if (Array.isArray(entry)) {
    return entry.map((item) => canonicalizeJsonValue(item)) as JsonObject[string];
  }
  if (entry && typeof entry === "object") {
    return canonicalizeJsonObject(entry as JsonObject);
  }
  return entry;
}

/** Serialize with one separator newline; parsing removes the separator, preserving the body. */
export function serializeMarkdownDefinition(meta: JsonObject, body: string): string {
  const yaml = YAML.stringify(meta).trimEnd();
  return `---\n${yaml}\n---\n\n${body}`;
}

function packageVisibilityAt(value: unknown): PackageVisibility | undefined {
  const visibility = stringAt(value);
  if (visibility === "public" || visibility === "private") return visibility;
  return undefined;
}

function readAgentOverlays(value: unknown): Record<string, AgentConfigOverlay> {
  if (value === undefined) return {};
  return Object.fromEntries(
    Object.entries(requireTomlTable(value, "agents")).map(([slug, raw]) => [
      slug,
      requireTomlTable(raw, `agents.${slug}`),
    ]),
  );
}

function requireTomlTable(value: unknown, field: string): JsonObject {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(value) !== Object.prototype)
  ) {
    throw new Error(`mars.toml ${field} must be a table`);
  }
  return value as JsonObject;
}
