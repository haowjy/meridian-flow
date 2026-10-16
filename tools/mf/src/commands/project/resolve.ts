/** Project and Work resolution shared by thread, doc, and seed commands. */
import { decodeWorkHandle, type WorkHandle } from "@meridian/contracts/handles";
import { apiProjectWorksPath, type ListWorksResponse } from "@meridian/contracts/protocol";
import { CliError } from "../../core/cli-error";
import type { Session } from "../../core/session";

type BootstrapResult = { projectId: string };

/** `--project <id>`; omitted or `default` ensures and returns the writer's default project. */
export async function resolveProjectId(session: Session, raw: string | undefined): Promise<string> {
  if (raw && raw !== "default") return raw;
  const bootstrap = await session.request<BootstrapResult>(
    "POST",
    "/api/projects/bootstrap-default",
  );
  return bootstrap.projectId;
}

/** A Work as its handle names it (`w3` or `@w3`); a bare id passes through. */
export async function resolveWork(
  session: Session,
  projectId: string,
  raw: string,
): Promise<{ id: string; handle: WorkHandle }> {
  const text = raw.startsWith("@") ? raw.slice(1) : raw;
  const handle = decodeWorkHandle(text);
  const snapshot = await session.request<ListWorksResponse>("GET", apiProjectWorksPath(projectId));
  const work = snapshot.works.find((entry) =>
    handle ? entry.handle === handle : entry.id === text,
  );
  if (!work) {
    throw new CliError("not_found", `No Work ${text} in project ${projectId}`, {
      details: snapshot.works.map((entry) => `${entry.handle}  ${entry.name}`),
    });
  }
  return { id: work.id, handle: work.handle };
}

/** `--work w3` → that Work's id; omitted → No Work (null). */
export async function resolveWorkId(
  session: Session,
  projectId: string,
  raw: string | undefined,
): Promise<string | null> {
  return raw === undefined ? null : (await resolveWork(session, projectId, raw)).id;
}
