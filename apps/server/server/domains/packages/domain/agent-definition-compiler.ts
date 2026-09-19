/** Compiles preserved Mars source into presence-sensitive, content-addressed definitions. */
import {
  agentEffortAuthoringSchema,
  authoringToolContradiction,
  type ToolPolicy,
  toolReferencesSchema,
  toolRepresentationSchema,
} from "@meridian/contracts/agents";
import { z } from "zod";
import { sha256 } from "./helpers.js";
import { canonicalizeJsonObject } from "./mars-source.js";
import type { JsonObject } from "./types.js";

// Skill and subagent names are plain references; only tools carry alias folding.
const reference = z.string().trim().min(1);
const references = z.array(reference);
const skills = z.union([
  references.transform((load) => ({ load })),
  z.strictObject({ load: references.optional(), available: references.optional() }),
]);

const metadata = z.looseObject({
  name: reference.optional(),
  description: z.string().optional(),
  model: reference.optional(),
  effort: agentEffortAuthoringSchema.optional(),
  mode: z.enum(["primary", "subagent"]).optional(),
  "model-invocable": z.boolean().optional(),
  "user-invocable": z.boolean().optional(),
  tools: toolRepresentationSchema.optional(),
  "disallowed-tools": toolReferencesSchema.optional(),
  subagents: references.optional(),
  skills: skills.optional(),
  approval: z.enum(["default", "auto", "confirm", "never"]).optional(),
  autocompact: z.number().int().min(0).max(4_294_967_295).optional(),
  autocompact_pct: z.number().int().min(1).max(100).optional(),
});

const overlayMetadata = metadata.extend({
  tools: z
    .strictObject({
      allowed: toolReferencesSchema.optional(),
      disallowed: toolReferencesSchema.optional(),
    })
    .optional(),
});

export type NormalizedAgentMetadata = z.infer<typeof metadata>;
export interface CompiledAgentDefinition {
  schemaVersion: 1;
  systemPrompt: string;
  metadata: NormalizedAgentMetadata;
}
export interface AgentCompilationDiagnostic {
  field: string;
  message: string;
}
export type AgentCompilationResult =
  | { ok: true; definition: CompiledAgentDefinition; digest: string }
  | { ok: false; diagnostics: AgentCompilationDiagnostic[] };

/**
 * Syntax compilation only. The binding owner must separately check runtime support,
 * resolve model aliases/dependencies, and retain the resulting execution configuration.
 */
export function compileAgentDefinition(source: {
  body: string;
  meta: JsonObject;
  config?: JsonObject;
}): AgentCompilationResult {
  const diagnostics: AgentCompilationDiagnostic[] = [];
  validateJson(source.meta, "meta", diagnostics);
  validateJson(source.config ?? {}, "config", diagnostics);
  if (diagnostics.length) return { ok: false, diagnostics };
  const frontmatter = normalizeAliases(source.meta, "meta", diagnostics);
  const overlay = normalizeAliases(source.config ?? {}, "config", diagnostics);
  const parsedMeta = metadata.safeParse(frontmatter);
  // Validate both layers: a valid overlay must not hide malformed source fields.
  if (!parsedMeta.success) addIssues("meta", parsedMeta.error, diagnostics);
  const parsedOverlay = overlayMetadata.safeParse(overlay);
  if (!parsedOverlay.success) addIssues("config", parsedOverlay.error, diagnostics);
  if (!parsedMeta.success || !parsedOverlay.success || diagnostics.length) {
    return { ok: false, diagnostics };
  }

  const { tools: overlayTools, ...overlayFields } = parsedOverlay.data;
  const merged: NormalizedAgentMetadata = { ...parsedMeta.data, ...overlayFields };
  if (parsedMeta.data.skills && parsedOverlay.data.skills) {
    merged.skills = { ...parsedMeta.data.skills, ...parsedOverlay.data.skills };
  }
  if (overlayTools?.allowed !== undefined) {
    const baseTools = parsedMeta.data.tools;
    const denials =
      baseTools && !Array.isArray(baseTools) && overlayTools.disallowed === undefined
        ? Object.entries(baseTools).filter(([, policy]) => policy === "deny")
        : [];
    merged.tools = denials.length
      ? (Object.fromEntries([
          ...overlayTools.allowed.map((tool) => [tool, "allow"] as const),
          ...denials,
        ]) as Record<string, ToolPolicy>)
      : overlayTools.allowed;
  }
  if (overlayTools?.disallowed !== undefined) {
    merged["disallowed-tools"] = overlayTools.disallowed;
    if (merged.tools && !Array.isArray(merged.tools)) {
      merged.tools = Object.fromEntries(
        Object.entries(merged.tools).filter(([, policy]) => policy === "allow"),
      );
    }
  }
  const contradiction = authoringToolContradiction(merged);
  if (contradiction) {
    diagnostics.push({ field: "tools", message: contradiction });
    return { ok: false, diagnostics };
  }
  const definition: CompiledAgentDefinition = {
    schemaVersion: 1,
    systemPrompt: source.body,
    metadata: canonicalizeJsonObject(merged) as NormalizedAgentMetadata,
  };
  return {
    ok: true,
    definition,
    digest: sha256(
      JSON.stringify(
        canonicalizeJsonObject({
          kind: "meridian.agent-definition",
          ...definition,
        }),
      ),
    ),
  };
}

function normalizeAliases(
  input: JsonObject,
  layer: string,
  diagnostics: AgentCompilationDiagnostic[],
): JsonObject {
  const result = { ...input };
  for (const [alias, canonical] of [
    ["model_invocable", "model-invocable"],
    ["user_invocable", "user-invocable"],
  ] as const) {
    if (!Object.hasOwn(result, alias)) continue;
    if (Object.hasOwn(result, canonical) && result[alias] !== result[canonical]) {
      diagnostics.push({ field: `${layer}.${canonical}`, message: `Conflicts with ${alias}` });
    } else {
      result[canonical] = result[alias];
    }
    delete result[alias];
  }
  return result;
}

function addIssues(layer: string, error: z.ZodError, diagnostics: AgentCompilationDiagnostic[]) {
  for (const issue of error.issues) {
    diagnostics.push({ field: [layer, ...issue.path].join("."), message: issue.message });
  }
}

function validateJson(
  value: unknown,
  field: string,
  diagnostics: AgentCompilationDiagnostic[],
  ancestors = new Set<object>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    diagnostics.push({ field, message: "Expected finite, acyclic JSON source content" });
    return;
  }
  ancestors.add(value);
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__") {
      diagnostics.push({ field: `${field}.${key}`, message: "Reserved metadata key __proto__" });
    } else {
      validateJson(entry, `${field}.${key}`, diagnostics, ancestors);
    }
  }
  ancestors.delete(value);
}
