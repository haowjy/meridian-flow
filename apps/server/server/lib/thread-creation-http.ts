import { type DraftId, isDraftId } from "@meridian/contracts";
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import {
  NO_OVERRIDES,
  type ThreadOverrides,
  threadOverridesSchema,
} from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import { AgentSelectionError } from "../domains/packages/index.js";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";
import {
  InvalidWorkAttachmentError,
  ThreadCreationConflictError,
  ThreadCreationNotFoundError,
} from "./thread-creation.js";

export function parseCreationTitle(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string")
    throw createError({ statusCode: 400, message: "title must be a string or null" });
  return value || null;
}

export function parseCreationDraftId(value: unknown): DraftId | undefined {
  if (value === undefined) return undefined;
  if (isDraftId(value)) return value;
  throw createError({ statusCode: 400, message: "draftId must be a draft id" });
}

export function parseCreationAiWriteMode(value: unknown): AiWriteMode | undefined {
  if (value === undefined) return undefined;
  if (value === "direct" || value === "draft") return value;
  throw createError({ statusCode: 400, message: "aiWriteMode must be 'direct' or 'draft'" });
}

export function parseCreationOverrides(value: unknown): ThreadOverrides {
  const parsed = threadOverridesSchema.default(NO_OVERRIDES).safeParse(value);
  if (!parsed.success)
    throw createError({
      statusCode: 400,
      message: "overrides must be a model and a reasoning setting, each or null",
    });
  return parsed.data;
}

export function throwThreadCreationError(error: unknown): never {
  if (error instanceof ThreadCreationNotFoundError)
    throw createError({ statusCode: 404, message: error.message });
  if (error instanceof ThreadCreationConflictError)
    throw createError({ statusCode: 409, message: error.message });
  if (error instanceof AgentSelectionError)
    throwHttpInterrupt(meridianErrorFromSystem("agent_not_found", error.message), 400);
  if (error instanceof InvalidWorkAttachmentError)
    throwHttpInterrupt(meridianErrorFromSystem("work_unavailable", error.message), 400);
  throw error;
}
