import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { listProjects } from "@/client/api/projects-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";

export async function loadProjectList(): Promise<Project[]> {
  return listProjects(ssrApiRequestInit());
}
