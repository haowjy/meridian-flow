import type { Project, ProjectDto } from "@meridian/contracts/projects";

export function projectDto(project: Project): ProjectDto {
  const { name, systemPrompt, ...rest } = project;
  return { ...rest, title: name, description: systemPrompt };
}
