import { z } from "zod";

export const ProjectSettings = z.object({
  defaultAgentId: z.string().uuid().optional(),
  reviewMode: z.boolean().optional(),
  disabledTools: z.array(z.string()).optional(),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const AgentConfig = z.object({
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().optional(),
  reasoning: z.enum(["off", "low", "medium", "high"]).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const UserPreferences = z.object({
  ui: z
    .object({
      theme: z.enum(["warm-paper"]).optional(),
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

export const OnboardingState = z.object({
  status: z.enum(["not_started", "in_progress", "completed"]).optional(),
  completedSteps: z.array(z.string()).optional(),
  firstProjectId: z.string().uuid().optional(),
  referralSource: z.string().optional(),
});
export type OnboardingState = z.infer<typeof OnboardingState>;
