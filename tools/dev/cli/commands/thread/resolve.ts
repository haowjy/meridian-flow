/** Thread targets: `<thread>` resolution (ref via the by-ref route, id, URL, or unique prefix). */
import {
  API_THREADS_PATH,
  apiProjectThreadByRefPath,
  type ListThreadsResponse,
} from "@meridian/contracts/protocol";
import { parseThreadRef, type Thread } from "@meridian/contracts/threads";
import { CliError } from "../../core/cli-error";
import type { OptionSpec } from "../../core/command";
import type { Session } from "../../core/session";
import { resolveProjectId } from "../project/resolve";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** `--project` for commands taking `<thread>`: the project a `cN`/`pN` ref lives in. */
export const THREAD_TARGET_OPTIONS: Record<string, OptionSpec> = {
  project: {
    type: "string",
    description: "Project for a cN/pN ref (default: the default project)",
  },
};

/**
 * Accepts a full id, an app URL containing one, a `cN`/`pN` ref (resolved by the
 * server in `project`, else the default project), or a unique id prefix (like git).
 */
export async function resolveThreadId(
  session: Session,
  raw: string,
  project?: string,
): Promise<string> {
  const embedded = raw.match(UUID)?.[0];
  if (embedded) return embedded.toLowerCase();
  if (parseThreadRef(raw)) {
    const projectId = await resolveProjectId(session, project);
    try {
      const thread = await session.request<Thread>(
        "GET",
        apiProjectThreadByRefPath(projectId, raw),
      );
      return thread.id;
    } catch (error) {
      if (error instanceof CliError && error.code === "not_found") {
        throw new CliError("not_found", `No live thread ${raw} in project ${projectId}`, {
          hint: "Refs are per project: pass --project <id>, or use the thread id (`./mf thread list`).",
        });
      }
      throw error;
    }
  }
  const { threads } = await session.request<ListThreadsResponse>("GET", API_THREADS_PATH);
  const matches = threads.filter((thread) => thread.id.startsWith(raw.toLowerCase()));
  if (matches.length === 1) return (matches[0] as { id: string }).id;
  if (matches.length === 0) {
    throw new CliError("not_found", `No thread matches "${raw}"`, {
      hint: "Run `./mf thread list` to see thread ids.",
    });
  }
  throw new CliError("usage", `"${raw}" matches ${matches.length} threads`, {
    details: matches
      .slice(0, 10)
      .map((thread) => ({ id: thread.id, ref: thread.ref, title: thread.title })),
    hint: "Use a longer prefix or the full id.",
  });
}
