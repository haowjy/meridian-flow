/**
 * The file policy at HTTP routes (file-access §4, §9): a person's grant on a
 * route's target, the write run with its grants bound so each seam confirms
 * them, and refusals mapped to status codes.
 */
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  type FileAccess,
  type FileAccessDenied,
  FileEditRefusedError,
  type FileGrant,
  type FileNeed,
  type FileTarget,
  isFileAccessDenied,
  type Principal,
  runWithEditGrants,
} from "../domains/file-policy/index.js";
import { throwHttpInterrupt } from "./interrupt-boundary.js";

export { containerTarget, documentTarget } from "./file-targets.js";

export function personPrincipal(userId: string): Principal {
  return { accountId: userId as UserId };
}

/** 404 hides existence; an archived Work's files are 403 `work_archived`. */
export function throwFileAccessDenied(denial: Pick<FileAccessDenied, "reason">): never {
  switch (denial.reason) {
    case "not_found":
      throw createError({ statusCode: 404, message: "Document not found" });
    case "work_archived":
      return throwHttpInterrupt(
        meridianErrorFromSystem("work_archived", "This Work is archived and read-only."),
        403,
      );
    case "agent_read_only":
    case "uploads_read_only":
      // Agent terms; a person never meets them.
      throw createError({ statusCode: 403, message: denial.reason });
  }
}

/** The person's grant on a target, or the route's refusal. */
export async function requireFileGrant<N extends FileNeed>(
  fileAccess: Pick<FileAccess, "authorize">,
  userId: string,
  target: FileTarget,
  need: N,
): Promise<FileGrant<N>> {
  const grant = await fileAccess.authorize(personPrincipal(userId), target, need);
  if (isFileAccessDenied(grant)) throwFileAccessDenied(grant);
  return grant;
}

/** Runs a write with its grants bound; a seam's refusal becomes the route's. */
export async function withEditGrants<T>(
  fileAccess: Pick<FileAccess, "confirmEdit">,
  grants: readonly FileGrant<"edit">[],
  operation: () => Promise<T>,
): Promise<T> {
  const result = await runWithEditGrants(fileAccess, grants, operation);
  if (result.ok) return result.value;
  const [denial] = result.refusal.refused;
  if (denial) throwFileAccessDenied(denial);
  throw result.refusal;
}

/** A seam refusal that escaped as an error, mapped like a preflight denial. */
export function rethrowFileEditRefusal(cause: unknown): never {
  if (cause instanceof FileEditRefusedError && cause.refused[0]) {
    throwFileAccessDenied(cause.refused[0]);
  }
  throw cause;
}
