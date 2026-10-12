/** HTTP import authorization and error translation; routes only parse transport. */
import type { H3Event } from "nitro/h3";
import { createError, getRouterParam } from "nitro/h3";
import { ImportError } from "../domains/import/index.js";
import { requireProjectOwner } from "../domains/projects/index.js";
import { requireAppUser } from "./auth-gate.js";
import { containerTarget, requireFileGrant, withEditGrants } from "./file-access-http.js";
import { requireRequestId } from "./request-id.js";
export async function resolveImportRoute(event: H3Event) {
  const { app, user } = await requireAppUser(event);
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const service = app.imports(projectId, user.userId);
  async function execute<T>(run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ImportError)
        throw createError({ statusCode: error.statusCode, message: error.message });
      throw error;
    }
  }
  return {
    projectId,
    service,
    userId: user.userId,
    read: execute,
    importId: () => requireRequestId(getRouterParam(event, "importId"), "importId"),
    async write<T>(run: () => Promise<T>) {
      const grants = await Promise.all(
        (["kb", "manuscript", "unfiled"] as const).map(async (scheme) =>
          requireFileGrant(
            app.fileAccess,
            user.userId,
            await containerTarget(app.workRepo, { projectId, scheme, workId: null }),
            "edit",
          ),
        ),
      );
      return execute(() => withEditGrants(app.fileAccess, grants, run));
    },
  };
}
