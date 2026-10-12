/** Project and Work resolution shared by thread, doc, and seed commands. */
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

/** `@/` (or omitted) → No Work (null); `@slug` → that Work's id; a bare id passes through. */
export async function resolveWorkId(
  session: Session,
  projectId: string,
  raw: string | undefined,
): Promise<string | null> {
  if (raw === undefined || raw === "@/" || raw === "@") return null;
  if (!raw.startsWith("@")) return raw;
  const slug = raw.slice(1);
  const snapshot = await session.request<ListWorksResponse>("GET", apiProjectWorksPath(projectId));
  const work = snapshot.works.find((entry) => entry.slug === slug);
  if (!work) {
    throw new CliError("not_found", `No Work with slug @${slug} in project ${projectId}`, {
      details: snapshot.works.map((entry) => `@${entry.slug}`),
    });
  }
  return work.id;
}
