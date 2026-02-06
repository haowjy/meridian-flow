import { FolderOpen } from "lucide-react";
import { Project } from "../types/project";
import { ProjectRowCompact } from "./ProjectRowCompact";
import { ProjectSortDropdown } from "./ProjectSortDropdown";
import { useUIStore, type ProjectSortOrder } from "@/core/stores/useUIStore";
import { useMemo } from "react";
import { SectionHeader } from "@/shared/components/SectionHeader";

interface AllProjectsSectionProps {
  projects: Project[];
  onFavoriteToggle?: (id: string) => void;
  onRename?: (project: Project) => void;
  onDelete?: (project: Project) => void;
}

function sortProjects(
  projects: Project[],
  sortOrder: ProjectSortOrder,
): Project[] {
  const sorted = [...projects];

  switch (sortOrder) {
    case "updated":
      return sorted.sort(
        (a, b) =>
          new Date(b.lastActivityAt).getTime() -
          new Date(a.lastActivityAt).getTime(),
      );
    case "name-asc":
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case "name-desc":
      return sorted.sort((a, b) => b.name.localeCompare(a.name));
    case "created-newest":
      return sorted.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    case "created-oldest":
      return sorted.sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
    default:
      return sorted;
  }
}

export function AllProjectsSection({
  projects,
  onFavoriteToggle,
  onRename,
  onDelete,
}: AllProjectsSectionProps) {
  const sortOrder = useUIStore((state) => state.projectSortOrder);

  const sortedProjects = useMemo(
    () => sortProjects(projects, sortOrder),
    [projects, sortOrder],
  );

  return (
    <section>
      <SectionHeader
        icon={<FolderOpen className="text-muted-foreground size-4.5" />}
        title="All Projects"
        count={projects.length}
        action={<ProjectSortDropdown />}
        size="compact"
      />

      {/* Content */}
      {sortedProjects.length === 0 ? (
        <div className="text-muted-foreground py-12 text-center">
          <p className="type-body">No projects found</p>
        </div>
      ) : (
        <div className="border-border divide-border divide-y overflow-hidden rounded-lg border">
          {sortedProjects.map((project) => (
            <ProjectRowCompact
              key={project.id}
              project={project}
              onFavoriteToggle={onFavoriteToggle}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </section>
  );
}
