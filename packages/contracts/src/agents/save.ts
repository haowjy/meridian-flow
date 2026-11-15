/**
 * Save: the step that makes an Agent package's files the version new chats use. A package is a
 * level's own files (`folder` `""`) or one import (`packages/<name>/`).
 */
import { z } from "zod";
import { isUuid } from "../request-id.js";
import type { AgentsLevel } from "./location.js";

const levelSchema = z.enum(["user", "project"]);

/** What Mars, or Flow, found in a package file. Only an `error` fails a Save. */
export interface AgentFinding {
  /** Package-relative: `mars.toml`, `agents/critic.md`. */
  file: string;
  /** Mars's code, or `flow.*`. */
  code: string;
  severity: "error" | "warning" | "info";
  path: (string | number)[];
  message: string;
}
export const agentFindingSchema = z.object({
  file: z.string(),
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
}) satisfies z.ZodType<AgentFinding>;

/** How a package's files differ from its saved version. */
export interface AgentFileChange {
  path: string;
  change: "added" | "changed" | "deleted";
}
export const agentFileChangeSchema = z.object({
  path: z.string(),
  change: z.enum(["added", "changed", "deleted"]),
}) satisfies z.ZodType<AgentFileChange>;

/**
 * Computed from the package's files and its latest Save, never stored:
 * `saved` the files are the saved version; `unsaved` they differ and pass;
 * `cant-save` they differ (or a newer reader reads them differently) and have an error;
 * `not-saved` there is no saved version; `removed` there is a saved version and no files.
 */
export type AgentPackageState = "saved" | "unsaved" | "cant-save" | "not-saved" | "removed";

export interface AgentPackageStatus {
  level: AgentsLevel;
  folder: string;
  state: AgentPackageState;
  /** The saved version's time; null with no saved version. */
  savedAt: string | null;
  /** The package's latest Save, for Undo; null with none. */
  saveId: string | null;
  /** Files added, changed or deleted since the saved version. */
  changes: AgentFileChange[];
  /** Errors and warnings in the package's files. */
  findings: AgentFinding[];
}
export const agentPackageStatusSchema = z.object({
  level: levelSchema,
  folder: z.string(),
  state: z.enum(["saved", "unsaved", "cant-save", "not-saved", "removed"]),
  savedAt: z.string().nullable(),
  saveId: z.string().nullable(),
  changes: z.array(agentFileChangeSchema),
  findings: z.array(agentFindingSchema),
}) satisfies z.ZodType<AgentPackageStatus>;

/** One package's result of a Save. A failed check is a result, never a refused write. */
export interface SaveOutcome {
  level: AgentsLevel;
  folder: string;
  outcome: "saved" | "failed" | "unchanged";
  saveId?: string;
  changes: AgentFileChange[];
  /** The errors when failed, the warnings when saved. */
  findings: AgentFinding[];
  /** `critic: read → edit`: what the Save made wider. */
  widened: string[];
  /** `critic is now critic__a, critic__b`. */
  renamed: string[];
}
export const saveOutcomeSchema = z.object({
  level: levelSchema,
  folder: z.string(),
  outcome: z.enum(["saved", "failed", "unchanged"]),
  saveId: z.string().optional(),
  changes: z.array(agentFileChangeSchema),
  findings: z.array(agentFindingSchema),
  widened: z.array(z.string()),
  renamed: z.array(z.string()),
}) satisfies z.ZodType<SaveOutcome>;

const projectIdSchema = z
  .string()
  .refine((value): boolean => isUuid(value), "must be a canonical UUID")
  .toLowerCase();

export const saveAgentsRequestSchema = z.strictObject({
  projectId: projectIdSchema.optional(),
  packages: z.union([
    z.literal("all"),
    z.array(z.strictObject({ level: levelSchema, folder: z.string() })),
  ]),
});
export type SaveAgentsRequest = z.infer<typeof saveAgentsRequestSchema>;
export const saveAgentsResponseSchema = z.object({ outcomes: z.array(saveOutcomeSchema) });

export const undoSaveRequestSchema = z.strictObject({
  projectId: projectIdSchema.optional(),
  level: levelSchema,
  saveId: z.string().refine((value): boolean => isUuid(value), "must be a canonical UUID"),
});
export type UndoSaveRequest = z.infer<typeof undoSaveRequestSchema>;
/** `undone` is false when a later Save of the package exists: nothing changed. */
export const undoSaveResponseSchema = z.object({ undone: z.boolean() });
