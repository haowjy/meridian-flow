/**
 * WorkspaceNavBody — the shared body of the project navigation rail: screen
 * destinations, the Chats controls, the live thread list, and the account row.
 *
 * LeftSidebar (desktop persistent rail) and NavigationDrawer (phone Sheet) both
 * compose this; each owns only its chrome — the collapse control / Sheet, the
 * wordmark header, and safe-area padding. `presentation` carries the
 * desktop↔phone touch-target and spacing differences (mirroring how
 * SettingsDialog/PhoneSettings share section bodies), and "close the drawer on
 * select" stays a chrome concern: NavigationDrawer passes `onSelect*` callbacks
 * that close the sheet, so the body never needs to know it lives in one.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AiWriteMode } from "@meridian/contracts/preferences";
import { FilePen, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";

import {
  useProjectPreferences,
  useUpdateProjectPreferences,
} from "@/client/query/useProjectPreferences";
import { AccountMenu } from "@/features/account/AccountMenu";
import { cn } from "@/lib/utils";
import { type ThreadFilter, ThreadPanel } from "../chat/ThreadPanel";
import { useCreateChat } from "../chat/use-create-chat";
import { SidebarSectionLabel } from "./SidebarSectionLabel";
import { SCREENS, type ScreenKey, type ScreenMeta } from "./screens";
import { ThreadSearch, ViewMenu } from "./ThreadListControls";

export type WorkspaceNavPresentation = "desktop" | "phone";

export type WorkspaceNavBodyProps = {
  projectId: string;
  activeScreen: ScreenKey;
  activeThreadId: string | null;
  onSelectScreen: (screen: ScreenKey) => void;
  onSelectThread: (threadId: string) => void;
  presentation: WorkspaceNavPresentation;
};

export function WorkspaceNavBody({
  projectId,
  activeScreen,
  activeThreadId,
  onSelectScreen,
  onSelectThread,
  presentation,
}: WorkspaceNavBodyProps) {
  const [threadFilter, setThreadFilter] = useState<ThreadFilter>("all");
  const [threadSearch, setThreadSearch] = useState("");
  const { preferences } = useProjectPreferences(projectId);
  const updatePreferences = useUpdateProjectPreferences(projectId);
  const { createChat, creating } = useCreateChat(projectId, onSelectThread);

  const phone = presentation === "phone";

  return (
    <>
      {/* Destination nav */}
      <div
        className={cn("flex shrink-0 flex-col", phone ? "gap-1 px-3 py-3" : "gap-0.5 px-2 pt-1")}
      >
        {SCREENS.map((screen) => (
          <ScreenNavItem
            key={screen.key}
            screen={screen}
            active={screen.key === activeScreen}
            presentation={presentation}
            onClick={() => onSelectScreen(screen.key)}
          />
        ))}
      </div>

      <AiWriteModeControl
        value={preferences.aiWriteMode ?? "direct"}
        disabled={updatePreferences.isPending}
        presentation={presentation}
        onChange={(aiWriteMode) => updatePreferences.mutate({ aiWriteMode })}
      />

      {/* Chats label + new chat · single-row search/view controls */}
      <div
        className={cn(
          "flex shrink-0 flex-col gap-1.5",
          phone ? "border-t border-border-subtle px-3 py-3" : "mt-3 px-3 pb-1",
        )}
      >
        <div className="flex items-center">
          <SidebarSectionLabel>
            <Trans>Chats</Trans>
          </SidebarSectionLabel>
          <button
            type="button"
            aria-label={t`New chat`}
            title={t`New chat`}
            disabled={creating}
            onClick={() => void createChat()}
            className={cn(
              "focus-ring ml-auto grid place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground disabled:opacity-50",
              phone ? "size-11 active:scale-[0.98]" : "size-7",
            )}
          >
            {phone ? (
              <span className="text-lg leading-none">+</span>
            ) : (
              <Plus className="size-4" aria-hidden />
            )}
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <ThreadSearch value={threadSearch} onChange={setThreadSearch} />
          <ViewMenu
            groupBy={preferences.threadGroupBy}
            groupByDisabled={updatePreferences.isPending}
            onGroupByChange={(threadGroupBy) => updatePreferences.mutate({ threadGroupBy })}
            filter={threadFilter}
            onFilterChange={setThreadFilter}
          />
        </div>
      </div>

      {/* Thread list — real data, transparent + headerless to share the rail tone */}
      <div className={cn("min-h-0 flex-1", !phone && "flex flex-col")}>
        <ThreadPanel
          projectId={projectId}
          activeThreadId={activeThreadId}
          onSelectThread={onSelectThread}
          transparent
          hideHeader
          groupBy={preferences.threadGroupBy}
          filter={threadFilter}
          searchQuery={threadSearch}
          pinnedThreadIds={preferences.pinnedThreadIds}
        />
      </div>

      <div
        className={cn("shrink-0 border-t border-border-subtle px-2", phone ? "pt-2" : "py-1.5")}
        style={phone ? { paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" } : undefined}
      >
        <AccountMenu />
      </div>
    </>
  );
}

function AiWriteModeControl({
  value,
  disabled,
  presentation,
  onChange,
}: {
  value: AiWriteMode;
  disabled: boolean;
  presentation: WorkspaceNavPresentation;
  onChange: (value: AiWriteMode) => void;
}) {
  const phone = presentation === "phone";
  const groupName = useId();
  return (
    <fieldset
      className={cn(
        "min-w-0 shrink-0 border-0 border-t border-border-subtle",
        phone ? "px-3 py-3" : "mt-2 px-3 pt-2",
      )}
    >
      <legend className="visually-hidden">
        <Trans>AI write mode</Trans>
      </legend>
      <div className="mb-1.5 flex items-center gap-1.5 text-ink-muted">
        <FilePen className="size-3.5" aria-hidden />
        <SidebarSectionLabel>
          <Trans>AI write mode</Trans>
        </SidebarSectionLabel>
      </div>
      <div className={cn("grid gap-1", phone ? "grid-cols-1" : "grid-cols-2")}>
        <AiWriteModeOption
          name={groupName}
          value="draft"
          selected={value === "draft"}
          disabled={disabled}
          phone={phone}
          onSelect={onChange}
        >
          <Trans>Review before applying</Trans>
        </AiWriteModeOption>
        <AiWriteModeOption
          name={groupName}
          value="direct"
          selected={value === "direct"}
          disabled={disabled}
          phone={phone}
          onSelect={onChange}
        >
          <Trans>Apply directly</Trans>
        </AiWriteModeOption>
      </div>
    </fieldset>
  );
}

function AiWriteModeOption({
  name,
  value,
  selected,
  disabled,
  phone,
  onSelect,
  children,
}: {
  name: string;
  value: AiWriteMode;
  selected: boolean;
  disabled: boolean;
  phone: boolean;
  onSelect: (value: AiWriteMode) => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "focus-within:focus-ring rounded-md",
        disabled ? "cursor-default" : "cursor-pointer",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(value)}
        className="visually-hidden"
      />
      <span
        className={cn(
          "block rounded-md border border-border-subtle px-2 text-left text-xs leading-snug transition-colors",
          phone ? "min-h-11 py-2.5" : "py-1.5",
          selected
            ? "bg-sidebar-accent font-medium text-foreground"
            : "bg-surface-warm text-ink-muted hover:border-border-focus hover:bg-sidebar-accent/60 hover:text-foreground",
          disabled && "opacity-60",
        )}
      >
        {children}
      </span>
    </label>
  );
}

function ScreenNavItem({
  screen,
  active,
  presentation,
  onClick,
}: {
  screen: ScreenMeta;
  active: boolean;
  presentation: WorkspaceNavPresentation;
  onClick: () => void;
}) {
  const Icon = screen.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "focus-ring flex items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors",
        presentation === "phone" ? "min-h-11 active:scale-[0.98]" : "py-1.5",
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-ink-muted hover:bg-sidebar-accent/50 hover:text-foreground",
      )}
    >
      <span className="grid size-5 place-items-center text-muted-foreground">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">{screen.label}</span>
    </button>
  );
}
