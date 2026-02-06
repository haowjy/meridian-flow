import { Link } from "@tanstack/react-router";
import { Star, MoreHorizontal, Pencil, Trash2, FolderOpen } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Project } from "../types/project";
import { useProjectStore } from "@/core/stores/useProjectStore";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";

interface ProjectRowCompactProps {
  project: Project;
  onFavoriteToggle?: (id: string) => void;
  onRename?: (project: Project) => void;
  onDelete?: (project: Project) => void;
}

export function ProjectRowCompact({
  project,
  onFavoriteToggle,
  onRename,
  onDelete,
}: ProjectRowCompactProps) {
  const setCurrentProject = useProjectStore((state) => state.setCurrentProject);

  const handleClick = () => {
    setCurrentProject(project);
  };

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onFavoriteToggle?.(project.id);
  };

  const timeAgo = formatDistanceToNow(new Date(project.lastActivityAt), {
    addSuffix: true,
  });

  return (
    <div className="group hover:bg-muted/50 flex items-center gap-3 rounded-sm px-4 py-3 transition-colors">
      {/* Favorite button */}
      <button
        onClick={handleFavoriteClick}
        className={cn(
          "shrink-0 rounded p-0.5 transition-colors",
          project.isFavorite
            ? "text-favorite hover:text-favorite/80"
            : "text-muted-foreground/40 hover:text-muted-foreground",
        )}
        aria-label={
          project.isFavorite ? "Remove from favorites" : "Add to favorites"
        }
      >
        <Star
          className="size-4.5"
          fill={project.isFavorite ? "currentColor" : "none"}
        />
      </button>

      {/* Project name (clickable link) */}
      <Link
        to="/projects/$slug"
        params={{ slug: project.slug }}
        onClick={handleClick}
        className="type-body text-foreground hover:text-primary min-w-0 flex-1 truncate transition-colors"
      >
        {project.name}
      </Link>

      {/* Updated time */}
      <span className="type-meta text-muted-foreground hidden shrink-0 sm:block">
        Updated {timeAgo}
      </span>

      {/* Actions menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="shrink-0 rounded p-1 opacity-0 transition-colors group-hover:opacity-100 hover:bg-[var(--hover)] focus:opacity-100"
            aria-label="Project actions"
          >
            <MoreHorizontal className="text-muted-foreground size-4.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link
              to="/projects/$slug"
              params={{ slug: project.slug }}
              onClick={handleClick}
            >
              <FolderOpen className="size-4.5" />
              Open
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onRename?.(project)}>
            <Pencil className="size-4.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleFavoriteClick}>
            <Star
              className="size-4.5"
              fill={project.isFavorite ? "currentColor" : "none"}
            />
            {project.isFavorite ? "Unfavorite" : "Favorite"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onDelete?.(project)}
          >
            <Trash2 className="size-4.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
