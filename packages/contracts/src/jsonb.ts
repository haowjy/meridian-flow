import { z } from "zod";

export const ProjectSettings = z.object({
  defaultAgentId: z.string().uuid().optional(),
  reviewMode: z.boolean().optional(),
  disabledTools: z.array(z.string()).optional(),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const UserPreferences = z.object({
  ui: z
    .object({
      theme: z.enum(["ink-jade"]).optional(),
      sidebarWidth: z.number().optional(),
      editorFontSize: z.number().optional(),
    })
    .optional(),
  defaults: z
    .object({
      model: z.string().optional(),
      agentId: z.string().uuid().optional(),
    })
    .optional(),
  writing: z
    .object({
      type: z.string().optional(),
      platform: z.string().optional(),
      voiceNotes: z.string().optional(),
    })
    .optional(),
});
export type UserPreferences = z.infer<typeof UserPreferences>;
