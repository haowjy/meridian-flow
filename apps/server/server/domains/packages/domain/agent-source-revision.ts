/** Builds a complete immutable source snapshot and its compiled Agent definitions. */
import {
  type CompiledAgentDefinition,
  compileAgentDefinition,
} from "./agent-definition-compiler.js";
import { sha256 } from "./helpers.js";
import { canonicalizeJsonObject, parseMarkdownDefinition, parseMarsToml } from "./mars-source.js";
import { bufferToSkillFileEntry, type SkillFiles, skillFileEntryToBuffer } from "./skill-files.js";

export interface AgentSourceSnapshot {
  coordinate: string;
  files: SkillFiles;
}
export interface PreparedAgentSourceRevision {
  coordinate: string;
  schemaVersion: 1;
  contentDigest: string;
  source: { files: SkillFiles };
  definitions: Array<{
    slug: string;
    definition: CompiledAgentDefinition;
    definitionDigest: string;
  }>;
}

export function prepareAgentSourceRevision(
  input: AgentSourceSnapshot,
): PreparedAgentSourceRevision {
  if (
    !input.coordinate.trim() ||
    input.coordinate.includes("\0") ||
    Buffer.from(input.coordinate).toString("utf8") !== input.coordinate
  ) {
    throw new Error("Agent source coordinate must be nonempty UTF-8 text without NUL");
  }
  const files: SkillFiles = Object.fromEntries(
    Object.entries(input.files).map(([name, entry]) => {
      if (
        name.startsWith("/") ||
        /^[a-z]:/i.test(name) ||
        name.includes("\\") ||
        name.split("/").some((part) => !part || part === "." || part === "..")
      ) {
        throw new Error(`Invalid Agent source file path: ${name}`);
      }
      const bytes = skillFileEntryToBuffer(entry);
      if (typeof entry === "string" && bytes.toString("utf8") !== entry) {
        throw new Error(`Agent source ${name} is not valid UTF-8 text`);
      }
      if (typeof entry !== "string" && bytes.toString("base64") !== entry.data) {
        throw new Error(`Invalid base64 Agent source file: ${name}`);
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
    if (typeof entry !== "string") throw new Error(`Agent source ${name} must be UTF-8 text`);
    return entry;
  };
  const overlays = Object.hasOwn(files, "mars.toml")
    ? parseMarsToml(textFile("mars.toml"), { packageNameFallback: input.coordinate }).agentOverlays
    : {};
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
      throw new Error(
        `${name}: ${compiled.diagnostics.map((item) => `${item.field}: ${item.message}`).join("; ")}`,
      );
    }
    definitions.push({ slug, definition: compiled.definition, definitionDigest: compiled.digest });
  }
  for (const slug of Object.keys(overlays)) {
    if (!definitions.some((definition) => definition.slug === slug)) {
      throw new Error(`Agent overlay has no source definition: ${slug}`);
    }
  }
  const source = { files };
  return {
    coordinate: input.coordinate,
    schemaVersion: 1,
    contentDigest: sha256(
      JSON.stringify(
        canonicalizeJsonObject({
          kind: "meridian.agent-source",
          schemaVersion: 1,
          coordinate: input.coordinate,
          ...source,
        }),
      ),
    ),
    source,
    definitions,
  };
}
