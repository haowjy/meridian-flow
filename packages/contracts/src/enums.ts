import { z } from "zod";

export const ContextScope = z.enum(["project", "session"]);
export type ContextScope = z.infer<typeof ContextScope>;

export const AdapterType = z.enum(["local", "google_drive", "dropbox", "notion"]);
export type AdapterType = z.infer<typeof AdapterType>;

export const FileType = z.enum(["markdown", "docx", "image", "pdf", "text"]);
export type FileType = z.infer<typeof FileType>;

export const ThreadKind = z.enum(["primary", "subagent"]);
export type ThreadKind = z.infer<typeof ThreadKind>;

export const ThreadStatus = z.enum(["active", "archived"]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

export const OriginType = z.enum(["spawn", "handoff", "fork"]);
export type OriginType = z.infer<typeof OriginType>;

export const SpawnStatus = z.enum(["running", "succeeded", "failed", "cancelled"]);
export type SpawnStatus = z.infer<typeof SpawnStatus>;

export const TurnRole = z.enum(["user", "assistant", "system", "compaction"]);
export type TurnRole = z.infer<typeof TurnRole>;

export const TurnStatus = z.enum(["pending", "streaming", "complete", "cancelled", "error"]);
export type TurnStatus = z.infer<typeof TurnStatus>;

export const BlockType = z.enum([
  "text",
  "thinking",
  "tool_use",
  "tool_result",
  "image",
  "reference",
  "helper_status",
]);
export type BlockType = z.infer<typeof BlockType>;

export const AgentMode = z.enum(["primary", "subagent"]);
export type AgentMode = z.infer<typeof AgentMode>;

export const SourceType = z.enum(["builtin", "package", "user"]);
export type SourceType = z.infer<typeof SourceType>;

export const SkillType = z.enum(["principle", "guardrail", "reference"]);
export type SkillType = z.infer<typeof SkillType>;

export const LoadingMode = z.enum(["preloaded", "available"]);
export type LoadingMode = z.infer<typeof LoadingMode>;

export const CreditLotSource = z.enum(["purchase", "grant", "subscription", "debt"]);
export type CreditLotSource = z.infer<typeof CreditLotSource>;

export const TransactionType = z.enum(["purchase", "grant", "consumption", "expiration", "refund"]);
export type TransactionType = z.infer<typeof TransactionType>;

export const SubscriptionPlan = z.enum(["pro"]);
export type SubscriptionPlan = z.infer<typeof SubscriptionPlan>;

export const SubscriptionStatus = z.enum(["active", "past_due", "cancelled", "trialing"]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

export const YjsOriginType = z.enum(["user", "agent", "system", "import"]);
export type YjsOriginType = z.infer<typeof YjsOriginType>;

export const ExecutionSide = z.enum(["provider", "local", "client"]);
export type ExecutionSide = z.infer<typeof ExecutionSide>;

export const DocumentRelationship = z.enum(["editing", "reading", "created"]);
export type DocumentRelationship = z.infer<typeof DocumentRelationship>;
