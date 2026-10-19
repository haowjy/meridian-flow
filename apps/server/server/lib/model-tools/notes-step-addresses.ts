/** Notes admission proves canonical owner and thread coordinates without allocating a folder. */
import { splitDocumentFile } from "@meridian/agent-edit/integration";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { NotesStepAddresses } from "../../domains/runtime/ports/notes-step-addresses.js";
import { isToolError, resolveContextPort, type ToolWiringDeps } from "./tool-context.js";

export function createNotesStepAddresses(deps: ToolWiringDeps): NotesStepAddresses {
  return {
    async admits(threadId: ThreadId, call: { name: string; arguments: unknown }): Promise<boolean> {
      if (!["read", "write", "ls", "search"].includes(call.name)) return false;
      const args = call.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) return false;
      const fields = args as Record<string, unknown>;
      const paths = [call.name === "search" ? fields.scope : fields.path];
      if (call.name === "write") {
        if (fields.command === "copy" && fields.from === undefined) return false;
        if (fields.from !== undefined) {
          if (!fields.from || typeof fields.from !== "object" || Array.isArray(fields.from))
            return false;
          paths.push((fields.from as Record<string, unknown>).path);
        }
      }
      if (paths.some((path) => typeof path !== "string" || path.length === 0)) return false;
      const context = await resolveContextPort(deps, threadId);
      if (isToolError(context)) return false;
      const resolution = context.resolution;
      const own = parseUnifiedContextUri("scratch://$THREAD/", {
        variables: resolution.variables,
      });
      if (!own.ok || !own.value.threadRef) return false;
      const ownOwner = own.value.authority;
      for (const path of paths as string[]) {
        const parsed = parseUnifiedContextUri(splitDocumentFile(path).filePath, {
          variables: resolution.variables,
        });
        if (!parsed.ok || parsed.value.scheme !== "scratch" || !parsed.value.threadRef)
          return false;
        const { authority, threadRef } = parsed.value;
        const sameOwner =
          (authority.kind === "work" &&
            ownOwner.kind === "work" &&
            authority.workSlug === ownOwner.workSlug) ||
          (authority.kind === "lineage" &&
            ownOwner.kind === "lineage" &&
            authority.rootThreadRef === ownOwner.rootThreadRef);
        if (!sameOwner || threadRef !== own.value.threadRef) return false;
        const owner =
          authority.kind === "work"
            ? resolution.workAuthorities.get(authority.workSlug)
            : authority.kind === "lineage"
              ? authority
              : null;
        if (
          !owner ||
          (await resolution.threadFolders?.resolve(
            resolution.thread.projectId,
            owner,
            threadRef,
          )) !== threadId
        )
          return false;
      }
      return true;
    },
  };
}
