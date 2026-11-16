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

/**
 * The findings a writer is shown: errors and warnings. Info says what Flow ignored and is for the
 * editor's own marks only, so every list, chip, count and the AI's `save_agents` text takes its
 * findings through this.
 */
export const shownFindings = <T extends Pick<AgentFinding, "severity">>(
  findings: readonly T[],
): T[] => findings.filter((finding) => finding.severity !== "info");

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
 * `saved` the files are the saved version; `unsaved` they differ;
 * `cant-save` the package has an error that leaves nothing readable (a broken `mars.toml`), so a
 * Save would fail; an error in one Agent's or skill's file does not do this: the Save keeps that
 * item's last saved version, or leaves it out;
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
  /** Every Save of this package that an Undo took back, so an old receipt can say "Undone". */
  undoneSaveIds: string[];
  undoable: { saveId: string; at: string; by: "writer" | "ai" } | null;
  /** Files added, changed or deleted since the saved version. */
  changes: AgentFileChange[];
  /** Errors, warnings and Info in the package's files; show them through `shownFindings`. */
  findings: AgentFinding[];
}
export const agentPackageStatusSchema = z.object({
  level: levelSchema,
  folder: z.string(),
  state: z.enum(["saved", "unsaved", "cant-save", "not-saved", "removed"]),
  savedAt: z.string().nullable(),
  saveId: z.string().nullable(),
  undoneSaveIds: z.array(z.string()),
  undoable: z
    .object({ saveId: z.string(), at: z.string(), by: z.enum(["writer", "ai"]) })
    .nullable(),
  changes: z.array(agentFileChangeSchema),
  findings: z.array(agentFindingSchema),
}) satisfies z.ZodType<AgentPackageStatus>;

/**
 * One package's result of a Save. A Save fails only for an error that leaves nothing readable (a
 * broken `mars.toml`): the previous saved version stays. An error in one Agent's or skill's file
 * stops that edit from being used and the rest saves: the item keeps its last saved version
 * (`kept`), or is out of the saved version when it has none (`leftOut`). Neither is a refused
 * write: the files are as the editor left them.
 */
export interface SaveOutcome {
  level: AgentsLevel;
  folder: string;
  outcome: "saved" | "failed" | "unchanged";
  saveId?: string;
  changes: AgentFileChange[];
  /** Errors first (a failed Save's, and each left-out item's), then warnings. */
  findings: AgentFinding[];
  /**
   * Package-relative paths of Agents and skills with an error whose last saved version stays in
   * use: the edit with the error is not. Their errors come first in `findings`.
   */
  kept: string[];
  /** Paths of Agents and skills with an error and no usable saved version: not in use at all. */
  leftOut: string[];
  /** `critic is now critic__a, critic__b`. */
  renamed: string[];
  /** The package had a saved version before this Save: what new chats keep when it fails. */
  savedBefore: boolean;
}
export const saveOutcomeSchema = z.object({
  level: levelSchema,
  folder: z.string(),
  outcome: z.enum(["saved", "failed", "unchanged"]),
  saveId: z.string().optional(),
  changes: z.array(agentFileChangeSchema),
  findings: z.array(agentFindingSchema),
  kept: z.array(z.string()),
  leftOut: z.array(z.string()),
  renamed: z.array(z.string()),
  // A chat's card stored before this field read as a package saved before.
  savedBefore: z.boolean().default(true),
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
export const undoSaveResponseSchema = z.object({
  undone: z.boolean(),
  reason: z.enum(["already-undone", "later-save", "not-undoable", "not-found"]).nullable(),
});
export type UndoSaveResponse = z.infer<typeof undoSaveResponseSchema>;
