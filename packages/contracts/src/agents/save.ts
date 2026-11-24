import { z } from "zod";
import { isUuid } from "../request-id.js";
import type { AgentsLevel } from "./location.js";

const levelSchema = z.enum(["user", "project"]);

export interface AgentFinding {
  file: string;
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

export const shownFindings = <T extends Pick<AgentFinding, "severity">>(
  findings: readonly T[],
): T[] => findings.filter((finding) => finding.severity !== "info");

export interface AgentFileChange {
  path: string;
  change: "added" | "changed" | "deleted";
}
export const agentFileChangeSchema = z.object({
  path: z.string(),
  change: z.enum(["added", "changed", "deleted"]),
}) satisfies z.ZodType<AgentFileChange>;

export type AgentPackageState = "saved" | "unsaved" | "cant-save" | "not-saved" | "removed";

export interface AgentPackageStatus {
  level: AgentsLevel;
  folder: string;
  state: AgentPackageState;
  savedAt: string | null;
  saveId: string | null;
  undoneSaveIds: string[];
  undoable: { saveId: string; at: string; by: "writer" | "ai" } | null;
  changes: AgentFileChange[];
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

export interface SaveOutcome {
  level: AgentsLevel;
  folder: string;
  outcome: "saved" | "failed" | "unchanged";
  saveId?: string;
  changes: AgentFileChange[];
  findings: AgentFinding[];
  kept: string[];
  leftOut: string[];
  renamed: string[];
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
