/** Debug account-skill add/delete: copies packaged skills or accepts a paste. */
import type { UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  type AccountSkillInstall,
  AccountSkillInstallConflictError,
  type AccountSkillInstallStore,
  type AgentRevisionStore,
  installPackagedAccountSkill,
  PackagedSkillNotFoundError,
} from "../domains/packages/index.js";
import { resolveRecentEventsEnabled } from "./env.js";

export function assertDebugAccountSkillsEnabled(): void {
  if (!resolveRecentEventsEnabled({ rawNodeEnv: process.env.NODE_ENV })) {
    throw createError({ statusCode: 404, message: "Account skill debug is not enabled" });
  }
}

export type DebugAccountSkillAddInput =
  | { slug: string }
  | { slug: string; name: string; description: string; body: string };

export function parseDebugAccountSkillAdd(raw: unknown): DebugAccountSkillAddInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const record = raw as Record<string, unknown>;
  const slug = parseSlug(record.slug);
  const name = optionalTrimmed(record.name);
  const description = optionalTrimmed(record.description);
  const body = typeof record.body === "string" ? record.body : undefined;
  if (name !== undefined || description !== undefined || body !== undefined) {
    if (!name || description === undefined || body === undefined) {
      throw createError({
        statusCode: 400,
        message: "Paste create requires name, description, and body",
      });
    }
    return { slug, name, description, body };
  }
  return { slug };
}

export async function handleAddDebugAccountSkill(input: {
  installs: AccountSkillInstallStore;
  agentRevisions: AgentRevisionStore;
  ownerUserId: UserId;
  body: DebugAccountSkillAddInput;
}): Promise<AccountSkillInstall> {
  try {
    if ("name" in input.body) {
      return await input.installs.insert({
        ownerUserId: input.ownerUserId,
        slug: input.body.slug,
        name: input.body.name,
        description: input.body.description,
        body: input.body.body,
      });
    }
    return await installPackagedAccountSkill({
      installs: input.installs,
      agentRevisions: input.agentRevisions,
      ownerUserId: input.ownerUserId,
      slug: input.body.slug,
    });
  } catch (cause) {
    if (cause instanceof PackagedSkillNotFoundError) {
      throw createError({ statusCode: 404, message: cause.message });
    }
    if (cause instanceof AccountSkillInstallConflictError) {
      throw createError({ statusCode: 409, message: cause.message });
    }
    throw cause;
  }
}

export async function handleDeleteDebugAccountSkill(input: {
  installs: AccountSkillInstallStore;
  ownerUserId: UserId;
  slug: string;
}): Promise<void> {
  await input.installs.deleteBySlug(input.ownerUserId, parseSlug(input.slug));
}

function parseSlug(value: unknown): string {
  if (typeof value !== "string") {
    throw createError({ statusCode: 400, message: "`slug` must be a string" });
  }
  const slug = value.trim();
  if (!slug || /[\s/]/.test(slug)) {
    throw createError({ statusCode: 400, message: "`slug` must be a nonempty path segment" });
  }
  return slug;
}

function optionalTrimmed(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw createError({ statusCode: 400, message: "Paste fields must be strings" });
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
