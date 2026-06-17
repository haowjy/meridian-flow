/**
 * ProjectRow — editable project row for the desktop app sidebar.
 *
 * Purpose: render a sidebar menu item that supports navigation, inline rename,
 * soft-delete, streaming state, and relative-time chrome. Mobile drawer row
 * variants were removed with the app's desktop-only decision.
 */
import { t } from "@lingui/core/macro";
import type { Project } from "@meridian/contracts/projects";
import { Link, useNavigate } from "@tanstack/react-router";
import { Pencil, Trash2 } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { announce, useProjectActions } from "@/client/stores";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { displayProjectTitle } from "@/lib/project-title";

export type ProjectRowProps = {
  project: Project;
  isActive?: boolean;
  isStreaming?: boolean;
  timeLabel?: string;
};

type Mode = "view" | "editing";
export function ProjectRow({
  project,
  isActive = false,
  isStreaming = false,
  timeLabel,
}: ProjectRowProps) {
  const actions = useProjectActions();
  const navigate = useNavigate();
  const title = displayProjectTitle(project.title);

  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    if (mode === "view") setDraft(title);
  }, [title, mode]);

  useEffect(() => {
    if (mode !== "editing") return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [mode]);

  const enterEdit = useCallback(() => {
    setDraft(title);
    closedRef.current = false;
    setMode("editing");
  }, [title]);

  const commit = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    const trimmed = draft.trim();
    if (trimmed) {
      actions.rename(project.id, trimmed);
    }
    setMode("view");
    const resolved = trimmed || displayProjectTitle(null);
    announce(t`Renamed to ${resolved}`);
  }, [actions, draft, project.id]);

  const cancel = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    setDraft(title);
    setMode("view");
  }, [title]);

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
  }

  function handleTitleMouseDown(event: MouseEvent<HTMLAnchorElement>) {
    if (event.detail === 2) {
      event.preventDefault();
      event.stopPropagation();
      enterEdit();
    }
  }

  function handlePencilClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    enterEdit();
  }

  function handleTrashClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!actions.softDelete(project.id, project)) return;
    if (isActive) {
      void navigate({ to: "/home" });
    }
    announce(t`Project deleted. Press undo to restore.`);
  }

  if (mode === "editing") {
    return (
      <SidebarMenuItem>
        <div className="focus-within:border-border-focus relative flex h-8 items-center gap-2 rounded-md border border-transparent bg-sidebar-accent/40 pr-12 pl-2 text-sm">
          {isStreaming ? <span aria-hidden className="streaming-dot" /> : null}
          <input
            ref={inputRef}
            type="text"
            value={draft}
            aria-label={t`Rename project`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleInputKeyDown}
            onBlur={commit}
            className="focus-ring min-w-0 flex-1 truncate rounded-sm border-0 bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={title}
        className="focus-ring pr-[64px]"
      >
        <Link
          to="/project/$projectId"
          params={{ projectId: project.id }}
          onMouseDown={handleTitleMouseDown}
        >
          {isStreaming ? (
            <>
              <span aria-hidden className="streaming-dot" />
              <span className="visually-hidden">{t`Streaming`}</span>
            </>
          ) : null}
          <span className="truncate">{title}</span>
        </Link>
      </SidebarMenuButton>

      <div className="pointer-events-none absolute top-1/2 right-1.5 z-10 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100 group-focus-within/menu-item:pointer-events-auto group-focus-within/menu-item:opacity-100">
        <button
          type="button"
          aria-label={t`Rename project`}
          onClick={handlePencilClick}
          onPointerDown={(e) => e.stopPropagation()}
          className="inline-icon-button focus-ring pointer-events-auto"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={t`Delete project`}
          onClick={handleTrashClick}
          onPointerDown={(e) => e.stopPropagation()}
          className="inline-icon-button focus-ring pointer-events-auto hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {timeLabel ? (
        <span className="text-meta pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground opacity-100 transition-opacity group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0">
          {timeLabel}
        </span>
      ) : null}
    </SidebarMenuItem>
  );
}
