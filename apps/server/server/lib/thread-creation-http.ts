/** Shared root-creation request validation and definite-refusal transport mapping. */
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import { throwHttpInterrupt } from "./interrupt-boundary.js";
import {
  AgentBindingNotFoundError,
  InvalidWorkAttachmentError,
  ThreadCreationConflictError,
} from "./thread-creation.js";

export function parseCreationTitle(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string")
    throw createError({ statusCode: 400, message: "title must be a string or null" });
  return value || null;
}

export function throwThreadCreationError(error: unknown): never {
  if (error instanceof ThreadCreationConflictError)
    throw createError({ statusCode: 409, message: error.message });
  if (error instanceof AgentBindingNotFoundError)
    throwHttpInterrupt(meridianErrorFromSystem("agent_not_found", error.message), 400);
  if (error instanceof InvalidWorkAttachmentError)
    throwHttpInterrupt(meridianErrorFromSystem("work_unavailable", error.message), 400);
  throw error;
}
