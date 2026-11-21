/** Project and Work resolution shared by thread, doc, and seed commands. */
import { decodeWorkHandle, type WorkHandle } from "@meridian/contracts/handles";
import {
  API_PROJECTS_PATH,
  apiProjectWorksPath,
  type ListProjectsResponse,
} from "@meridian/contracts/protocol";
import { worksSnapshotSchema } from "@meridian/contracts/works";
import { CliError } from "../../core/cli-error";
import type { Session } from "../../core/session";
import { jsonResponse, unknownJsonResponse } from "../../core/session";

/**
 * `--project <id>`; omitted or `default` reads the writer's oldest live project. Authentication
 * already made one when the account had none, so this never writes.
 */
export async function resolveProjectId(session: Session, raw: string | undefined): Promise<string> {
  if (raw && raw !== "default") return raw;
  const { projects } = (await session.request("GET", API_PROJECTS_PATH, undefined, {
    decode: unknownJsonResponse,
  })) as ListProjectsResponse;
  const oldest = projects
    .filter((project) => !project.deletedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!oldest) throw new CliError("not_found", "The account has no project");
  return oldest.id;
}

/** A Work as its handle names it (`w3` or `@w3`); a bare id passes through. */
export async function resolveWork(
  session: Session,
  projectId: string,
  raw: string,
): Promise<{ id: string; handle: WorkHandle; draftId: string | null }> {
  const text = raw.startsWith("@") ? raw.slice(1) : raw;
  const handle = decodeWorkHandle(text);
  const snapshot = await session.request("GET", apiProjectWorksPath(projectId), undefined, {
    decode: jsonResponse(worksSnapshotSchema),
  });
  const work = snapshot.works.find((entry) =>
    handle ? entry.handle === handle : entry.id === text,
  );
  if (!work) {
    throw new CliError("not_found", `No Work ${text} in project ${projectId}`, {
      details: snapshot.works.map((entry) => `${entry.handle}  ${entry.name}`),
    });
  }
  const workHandle = decodeWorkHandle(work.handle);
  if (!workHandle)
    throw new CliError("protocol", `Server returned malformed Work handle ${work.handle}`);
  return { id: work.id, handle: workHandle, draftId: work.draftId };
}

/** `--work w3` → that Work's id; omitted → No Work (null). */
export async function resolveWorkId(
  session: Session,
  projectId: string,
  raw: string | undefined,
): Promise<string | null> {
  return raw === undefined ? null : (await resolveWork(session, projectId, raw)).id;
}
