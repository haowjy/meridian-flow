import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  type FileAccess,
  type FileAccessDenied,
  type FileGrant,
  type FileNeed,
  type FileTarget,
  isFileAccessDenied,
  type Principal,
  runWithEditGrants,
} from "../domains/file-policy/index.js";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";
import { throwContextWorkUnavailableHttpError } from "./context-error-http.js";

export { containerTarget, documentTarget } from "./file-targets.js";

function personPrincipal(userId: string): Principal {
  return { accountId: userId as UserId };
}

export function throwFileAccessDenied(denial: Pick<FileAccessDenied, "reason">): never {
  switch (denial.reason) {
    case "not_found":
      throw createError({ statusCode: 404, message: "Document not found" });
    case "work_deleted":
      return throwContextWorkUnavailableHttpError("work_deleted");
    case "work_archived":
      return throwHttpInterrupt(
        meridianErrorFromSystem("work_archived", "This Work is archived and read-only."),
        403,
      );
    case "chat_frozen":
      return throwHttpInterrupt(
        meridianErrorFromSystem(
          "chat_frozen",
          "This chat is in the trash, so its drafts are read-only. Restore the chat to change them.",
        ),
        403,
      );
    case "agent_read_only":
    case "uploads_read_only":
    case "ai_access_denied":
      throw createError({ statusCode: 403, message: denial.reason });
  }
}

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

export async function withEditGrants<T>(
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">,
  grants: readonly FileGrant<"edit" | "command">[],
  operation: () => Promise<T>,
): Promise<T> {
  const result = await runWithEditGrants(fileAccess, grants, operation);
  if (result.ok) return result.value;
  const [denial] = result.refusal.refused;
  if (denial) throwFileAccessDenied(denial);
  throw result.refusal;
}
