/**
 * WorkspaceNavBody — shared project navigation for destination links, the AI
 * write-mode control, an optional desktop body, and the account row.
 *
 * LeftSidebar (desktop persistent rail) and NavigationDrawer (phone Sheet) both
 * compose this; each owns only its chrome — the collapse control / Sheet, the
 * wordmark header, and safe-area padding. `presentation` carries the
 * desktop↔phone touch-target and spacing differences (mirroring how
 * SettingsDialog/PhoneSettings share section bodies), and "close the drawer on
 * select" stays a chrome concern: NavigationDrawer passes `onSelect*` callbacks
 * that close the sheet, so the body never needs to know it lives in one.
 */
import type { ReactNode } from "react";

import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import { useUpdateWorkWriteMode, useWorks } from "@/client/query/useWorks";
import { AccountMenu } from "@/features/account/AccountMenu";
import { pendingDockedDraftCount } from "@/features/chat/docked-drafts";
import { cn } from "@/lib/utils";
import { AiWriteModeControl } from "./AiWriteModeControl";
import { SCREENS, type ScreenKey, type ScreenMeta, screenLabel } from "./screens";

export type WorkspaceNavPresentation = "desktop" | "phone";

export type WorkspaceNavBodyProps = {
  projectId: string;
  activeScreen: ScreenKey;
  onSelectScreen: (screen: ScreenKey) => void;
  presentation: WorkspaceNavPresentation;
  /** Persistent navigation content between the controls and account row. */
  children?: ReactNode;
};

export function WorkspaceNavBody({
  projectId,
  activeScreen,
  onSelectScreen,
  presentation,
  children,
}: WorkspaceNavBodyProps) {
  const { works } = useWorks(projectId);
  const currentWork = works?.[0] ?? null;
  const updateWriteMode = useUpdateWorkWriteMode(projectId, currentWork?.id ?? null);
  const workDrafts = useWorkDrafts(projectId, currentWork?.id ?? null);
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
        value={currentWork?.aiWriteMode ?? "direct"}
        disabled={!currentWork || updateWriteMode.isPending || workDrafts.groups == null}
        pendingChangeCount={pendingDockedDraftCount(workDrafts.groups)}
        presentation={presentation}
        onChange={(aiWriteMode) =>
          updateWriteMode.mutate(
            aiWriteMode === "direct" ? { aiWriteMode, confirmedPush: true } : aiWriteMode,
          )
        }
        onApplyAndSwitch={() =>
          // §3.4 confirm-and-push. The S3 mode mutation performs the
          // whole-branch push, then flips pushPolicy='auto' server-side (in that
          // order); the client only reflects the outcome. `updated` = flipped;
          // anything else (or a network error) means the push failed and the
          // writer stays in Draft.
          new Promise<boolean>((resolve) => {
            if (!currentWork) {
              resolve(false);
              return;
            }
            updateWriteMode.mutate(
              { aiWriteMode: "direct", confirmedPush: true },
              {
                onSuccess: (result) => resolve(result.status === "updated"),
                onError: () => resolve(false),
              },
            );
          })
        }
      />

      <div className="min-h-0 flex-1">{children}</div>

      <div
        className={cn("shrink-0 border-t border-border-subtle px-2", phone ? "pt-2" : "py-1.5")}
        style={phone ? { paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" } : undefined}
      >
        <AccountMenu />
      </div>
    </>
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
      <span className="min-w-0 flex-1 truncate">{screenLabel(screen.key)}</span>
    </button>
  );
}
