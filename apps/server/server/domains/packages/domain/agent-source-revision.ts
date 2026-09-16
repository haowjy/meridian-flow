/** Builds a complete immutable source snapshot and its compiled Agent definitions. */
import {
  type CompiledAgentDefinition,
  compileAgentDefinition,
} from "./agent-definition-compiler.js";
import { sha256 } from "./helpers.js";
import { canonicalizeJsonObject, parseMarkdownDefinition, parseMarsToml } from "./mars-source.js";
import { bufferToSkillFileEntry, type SkillFiles, skillFileEntryToBuffer } from "./skill-files.js";

export class AgentSourceError extends Error {}

export interface AgentSourceSnapshot {
  coordinate: string;
  files: SkillFiles;
  /** Manifest dependency names mapped to already-retained immutable package revisions. */
  dependencies?: Record<string, string>;
}
export interface PreparedAgentSourceRevision {
  coordinate: string;
  schemaVersion: 2;
  contentDigest: string;
  source: { files: SkillFiles };
  dependencies: Record<string, string>;
  definitions: Array<{
    slug: string;
    definition: CompiledAgentDefinition;
    definitionDigest: string;
  }>;
}

export function prepareAgentSourceRevision(
  input: AgentSourceSnapshot,
): PreparedAgentSourceRevision {
  try {
    if (
      !input.coordinate.trim() ||
      input.coordinate.includes("\0") ||
      Buffer.from(input.coordinate).toString("utf8") !== input.coordinate
    ) {
      throw new AgentSourceError("Agent source coordinate must be nonempty UTF-8 text without NUL");
    }
    const files: SkillFiles = Object.fromEntries(
      Object.entries(input.files).map(([name, entry]) => {
        if (
          name.startsWith("/") ||
          /^[a-z]:/i.test(name) ||
          name.includes("\\") ||
          name.split("/").some((part) => !part || part === "." || part === "..")
        ) {
          throw new AgentSourceError(`Invalid Agent source file path: ${name}`);
        }
        const bytes = skillFileEntryToBuffer(entry);
        if (typeof entry === "string" && bytes.toString("utf8") !== entry) {
          throw new AgentSourceError(`Agent source ${name} is not valid UTF-8 text`);
        }
        if (typeof entry !== "string" && bytes.toString("base64") !== entry.data) {
          throw new AgentSourceError(`Invalid base64 Agent source file: ${name}`);
        }
        return [
          name,
          bytes.includes(0)
            ? { encoding: "base64", data: bytes.toString("base64") }
            : bufferToSkillFileEntry(bytes),
        ];
      }),
    );
    const textFile = (name: string): string => {
      const entry = files[name];
      if (typeof entry !== "string")
        throw new AgentSourceError(`Agent source ${name} must be UTF-8 text`);
      return entry;
    };
    const manifest = Object.hasOwn(files, "mars.toml")
      ? parseMarsToml(textFile("mars.toml"), { packageNameFallback: input.coordinate })
      : undefined;
    const overlays = manifest?.agentOverlays ?? {};
    const dependencies = { ...input.dependencies };
    const declared = new Set(manifest?.dependencies.map((item) => item.name) ?? []);
    if (
      Object.keys(dependencies).length !== declared.size ||
      [...declared].some((name) => !Object.hasOwn(dependencies, name) || !dependencies[name])
    ) {
      throw new AgentSourceError(
        "Every manifest dependency must reference an exact retained package revision",
      );
    }
    const definitions: PreparedAgentSourceRevision["definitions"] = [];
    for (const name of Object.keys(files).sort()) {
      const match = /^agents\/([^/]+)\.md$/.exec(name);
      if (!match) continue;
      const slug = match[1];
      const compiled = compileAgentDefinition({
        ...parseMarkdownDefinition(textFile(name)),
        config: Object.hasOwn(overlays, slug) ? overlays[slug] : undefined,
      });
      if (!compiled.ok) {
        throw new AgentSourceError(
          `${name}: ${compiled.diagnostics.map((item) => `${item.field}: ${item.message}`).join("; ")}`,
        );
      }
      definitions.push({
        slug,
        definition: compiled.definition,
        definitionDigest: compiled.digest,
      });
    }
    for (const slug of Object.keys(overlays)) {
      if (!definitions.some((definition) => definition.slug === slug)) {
        throw new AgentSourceError(`Agent overlay has no source definition: ${slug}`);
      }
    }
    const source = { files };
    return {
      coordinate: input.coordinate,
      schemaVersion: 2,
      contentDigest: sha256(
        JSON.stringify(
          canonicalizeJsonObject({
            kind: "meridian.agent-source",
            schemaVersion: 2,
            coordinate: input.coordinate,
            ...source,
            dependencies,
          }),
        ),
      ),
      source,
      dependencies,
      definitions,
    };
  } catch (error) {
    if (error instanceof AgentSourceError) throw error;
    throw new AgentSourceError(error instanceof Error ? error.message : String(error));
  }
}
