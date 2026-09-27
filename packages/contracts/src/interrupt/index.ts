/**
 * Purpose: Defines the canonical interrupt envelope (error + interrupt) shared across HTTP, WS, and runtime surfaces.
 * Key decisions: JSON-natural shapes per execution-model §6.1; ArtifactRef includes a probe-gated liveView arm only (no viewer implementation).
 */

import { z } from "zod";
import type { JsonObject, JsonValue } from "../threads/index.js";

/** JSON Schema object describing the typed shape of a interrupt reply. */
export type JsonSchema = JsonObject;

export type MeridianErrorSource = "gateway" | "tool" | "child-agent" | "system";

export type MeridianError = {
  code: string;
  message: string;
  retryable: boolean;
  source: MeridianErrorSource;
  details?: JsonValue;
};

export const artifactRefSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("image"),
    url: z.string(),
    label: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("object"),
    uri: z.string(),
    label: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  z.strictObject({
    // DEFERRED(live-viewer): build the iframe overlay iff the live-preview
    // probe is green.
    type: z.literal("liveView"),
    url: z.string(),
    expiresAt: z.string().optional(),
  }),
]);

export type ArtifactRef = z.infer<typeof artifactRefSchema>;

/** A model may return an artifact URI directly; store it as an object ref. */
export function normalizeArtifactRef(value: string | ArtifactRef): ArtifactRef {
  return typeof value === "string" ? { type: "object", uri: value } : value;
}

/** Input form for tools that accept canonical artifact refs or shorthand URIs. */
export const artifactRefInputSchema = z
  .union([z.string(), artifactRefSchema])
  .transform(normalizeArtifactRef);

export interface AskRequest {
  interruptId: string;
  prompt: string;
  artifacts: ArtifactRef[];
  answerSchema: JsonSchema;
  /** Safe default applied when interrupt auto-resume fires on timeout. */
  recommended?: JsonValue | null;
  /** When true, timeout must not auto-resolve even if recommended is set. */
  requiresHuman?: boolean;
}

export type ErrorInterrupt = { kind: "error"; error: MeridianError };
export type AskInterrupt = { kind: "ask"; ask: AskRequest };
export type Interrupt = ErrorInterrupt | AskInterrupt;

export function errorInterrupt(error: MeridianError): ErrorInterrupt {
  return { kind: "error", error };
}

export function askInterrupt(ask: AskRequest): AskInterrupt {
  return { kind: "ask", ask };
}

export * from "./builders.js";
export * from "./mapping.js";
