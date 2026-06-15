/**
 * Mars package source parser/serializer: reads a Mars package directory and
 * parses mars.toml plus its markdown-fronted agent and skill definitions into
 * domain records (and serializes them back). Owns the on-disk Mars format; the
 * single module that knows the file layout.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";
import YAML from "yaml";

import { normalizeAgentMetaFields } from "./agent-gateway-meta.js";
import { booleanAt, isNodeError, objectAt, sha256, stringAt, stringsAt } from "./helpers.js";
import { normalizeSkillFilesForChecksum, readSkillFileFromDisk } from "./skill-files.js";
import type {
  AgentConfigOverlay,
  JsonObject,
  MarsDependency,
  PackageVisibility,
  ParsedAgentDefinition,
  ParsedMarsPackageSource,
  ParsedMarsToml,
  ParsedSkillDefinition,
} from "./types.js";

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
    dependencies: [
      ...readDependencies(parsed.dependencies, false),
      ...readDependencies(parsed["local-dependencies"], true),
    ],
    agentOverlays: readAgentOverlays(parsed.agents),
  };
}

export async function parseMarsPackageSource(sourceDir: string): Promise<ParsedMarsPackageSource> {
  const marsToml = await readFile(path.join(sourceDir, "mars.toml"), "utf8");
  const manifest = parseMarsToml(marsToml, { packageNameFallback: path.basename(sourceDir) });
  const [agents, skills] = await Promise.all([
    loadAgentDefinitions(sourceDir),
    loadSkillDefinitions(sourceDir),
  ]);
  return { sourceDir, manifest, agents, skills };
}

export async function loadAgentDefinitions(packageDir: string): Promise<ParsedAgentDefinition[]> {
  const agentsDir = path.join(packageDir, "agents");
  const entries = await readOptionalDir(agentsDir);
  const markdownFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
  return Promise.all(
    markdownFiles.map(async (entry) => parseAgentDefinitionFile(path.join(agentsDir, entry.name))),
  );
}

export async function parseAgentDefinitionFile(filePath: string): Promise<ParsedAgentDefinition> {
  const raw = await readFile(filePath, "utf8");
  const parsed = parseMarkdownDefinition(raw);
  return {
    slug: path.basename(filePath, ".md"),
    body: parsed.body,
    meta: normalizeAgentMeta(parsed.meta),
  };
}

export async function loadSkillDefinitions(packageDir: string): Promise<ParsedSkillDefinition[]> {
  const skillsDir = path.join(packageDir, "skills");
  const entries = await readOptionalDir(skillsDir);
  const skillDirs = entries.filter((entry) => entry.isDirectory());
  return Promise.all(
    skillDirs.map(async (entry) =>
      parseSkillDefinitionFile(path.join(skillsDir, entry.name, "SKILL.md")),
    ),
  );
}

export async function parseSkillDefinitionFile(filePath: string): Promise<ParsedSkillDefinition> {
  const raw = await readFile(filePath, "utf8");
  const parsed = parseMarkdownDefinition(raw);
  return {
    slug: path.basename(path.dirname(filePath)),
    body: parsed.body,
    meta: normalizeSkillMeta(parsed.meta),
    files: await readSkillFiles(path.dirname(filePath)),
  };
}

export function parseMarkdownDefinition(raw: string): { meta: JsonObject; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new Error("Markdown definition is missing YAML frontmatter");
  }
  const document = YAML.parse(match[1]);
  const meta = objectAt(document);
  const body = raw.slice(match[0].length).replace(/^\r?\n/, "");
  return { meta, body };
}

/** Canonical JSON object for checksum stability — keys sorted recursively. */
export function canonicalizeJsonObject(value: JsonObject): JsonObject {
  const sorted: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalizeJsonValue(value[key]);
  }
  return sorted;
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

/*
 * Checksum inputs MUST be canonicalized (sorted keys, deep) before the YAML
 * serialization below. The serialized markdown is key-order-sensitive, and
 * Postgres jsonb does not preserve object key order — so a checksum computed
 * over freshly-parsed meta at import time would never match one recomputed
 * over the same meta read back from the database, and every imported
 * definition would permanently read as "Edited". (The in-memory store
 * preserves JS insertion order, which is why tests can't catch this without
 * a Drizzle-backed case.)
 */
export function agentDefinitionContentChecksum(definition: {
  body: string;
  meta: JsonObject;
  config?: JsonObject;
}): string {
  return sha256(
    JSON.stringify({
      markdown: serializeMarkdownDefinition(
        canonicalizeJsonObject(definition.meta),
        definition.body,
      ),
      config: canonicalizeJsonObject(definition.config ?? {}),
    }),
  );
}

export function definitionContentChecksum(definition: {
  body: string;
  meta: JsonObject;
  files?: ParsedSkillDefinition["files"];
}): string {
  const files = normalizeSkillFilesForChecksum(definition.files ?? {});
  return sha256(
    JSON.stringify({
      markdown: serializeMarkdownDefinition(
        canonicalizeJsonObject(definition.meta),
        definition.body,
      ),
      files,
    }),
  );
}

/**
 * Serialize a markdown definition back to its on-disk format.
 *
 * Trims a single leading newline from the body (the frontmatter regex
 * leaves one extra newline between the `---` separator and the body text).
 * Rounds-tripping parse → serialize → parse must produce identical results
 * for checksum consistency.
 */
export function serializeMarkdownDefinition(meta: JsonObject, body: string): string {
  const yaml = YAML.stringify(meta).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n/, "")}`;
}

async function readSkillFiles(skillDir: string): Promise<ParsedSkillDefinition["files"]> {
  const files: ParsedSkillDefinition["files"] = {};
  await readSkillFilesInto(skillDir, skillDir, files);
  return files;
}

async function readSkillFilesInto(
  rootDir: string,
  currentDir: string,
  files: ParsedSkillDefinition["files"],
): Promise<void> {
  for (const entry of await readOptionalDir(currentDir)) {
    const fullPath = path.join(currentDir, entry.name);
    // Normalize Windows path separators to forward slashes for checksum
    // determinism — definitionContentChecksum uses these paths as keys.
    const relativePath = path.relative(rootDir, fullPath).split(path.sep).join("/");
    if (relativePath === "SKILL.md") continue;
    if (entry.isDirectory()) {
      await readSkillFilesInto(rootDir, fullPath, files);
    } else if (entry.isFile()) {
      files[relativePath] = await readSkillFileFromDisk(fullPath);
    }
  }
}

function packageVisibilityAt(value: unknown): PackageVisibility | undefined {
  const visibility = stringAt(value);
  if (visibility === "public" || visibility === "private") return visibility;
  return undefined;
}

export function normalizeAgentMeta(meta: JsonObject): JsonObject {
  return normalizeAgentMetaFields({
    ...meta,
    skills: stringsAt(meta.skills),
    subagents: stringsAt(meta.subagents),
    mode: agentModeFromMeta(meta),
  });
}

/** Canonical agent mode derived from normalized meta — also persisted to `agent_definitions.mode`. */
export function agentModeFromMeta(meta: JsonObject): "primary" | "subagent" {
  const mode = stringAt(meta.mode);
  if (mode === "subagent") return "subagent";
  if (mode === "primary") return "primary";
  return "primary";
}

/**
 * Normalize skill YAML frontmatter from kebab-case (Mars format) to
 * camelCase (domain types). This is the canonical normal form — all
 * downstream code uses camelCase and never sees kebab-case.
 *
 * Defaults: type="reference", modelInvocable=true, userInvocable=true,
 * isGlobal=false.
 */
function normalizeSkillMeta(meta: JsonObject): JsonObject {
  const normalized: JsonObject = { ...meta };
  if ("model-invocable" in normalized && !("modelInvocable" in normalized)) {
    normalized.modelInvocable = normalized["model-invocable"];
    delete normalized["model-invocable"];
  }
  if ("user-invocable" in normalized && !("userInvocable" in normalized)) {
    normalized.userInvocable = normalized["user-invocable"];
    delete normalized["user-invocable"];
  }
  if ("is-global" in normalized && !("isGlobal" in normalized)) {
    normalized.isGlobal = normalized["is-global"];
    delete normalized["is-global"];
  }
  normalized.type = stringAt(normalized.type) ?? "reference";
  normalized.modelInvocable = booleanAt(normalized.modelInvocable) ?? true;
  normalized.userInvocable = booleanAt(normalized.userInvocable) ?? true;
  normalized.isGlobal = booleanAt(normalized.isGlobal) ?? false;
  delete normalized.inputSchema;
  delete normalized["input-schema"];
  return normalized;
}

function readDependencies(value: unknown, local: boolean): MarsDependency[] {
  return Object.entries(objectAt(value)).map(([name, raw]) => {
    const dependency = objectAt(raw);
    return {
      name,
      ...(stringAt(dependency.path) ? { path: stringAt(dependency.path) } : {}),
      ...(stringAt(dependency.url) ? { url: stringAt(dependency.url) } : {}),
      ...(stringAt(dependency.version) ? { version: stringAt(dependency.version) } : {}),
      local,
    };
  });
}

function readAgentOverlays(value: unknown): Record<string, AgentConfigOverlay> {
  return Object.fromEntries(
    Object.entries(objectAt(value)).map(([slug, raw]) => [slug, objectAt(raw)]),
  );
}

/**
 * Read a directory that may not exist (silently returns [] for ENOENT).
 *
 * Agents/ and skills/ directories are optional in a Mars package. A
 * package with no agents just contributes skills to the dependency graph.
 */
async function readOptionalDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}
