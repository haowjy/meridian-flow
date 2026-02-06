import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { UserProfile } from "../types";
import { UserAvatar } from "./UserAvatar";
import { UserMenu } from "./UserMenu";
import { createUserMenuItems } from "../utils/menuBuilders";

/**
 * Props interface - explicitly defines what data and actions are needed.
 * Interface Segregation: Components receive only what they use.
 */
interface UserMenuButtonProps {
  profile: UserProfile;
  onSignOut: () => void;
  menuSide?: "top" | "bottom" | "right" | "left";
  showName?: boolean;
  className?: string;
}

/**
 * Composition component - assembles avatar + menu.
 *
 * Single Responsibility: Wire up avatar trigger with menu items.
 * Open/Closed: Menu items built from handlers, not hardcoded.
 * Dependency Inversion: Receives handlers via props, not hooks.
 */
export function UserMenuButton({
  profile,
  onSignOut,
  menuSide = "top",
  showName = true,
  className,
}: UserMenuButtonProps) {
  // Build menu items from handlers - extensible
  // Note: Settings uses href (Link) in menuBuilders, not a callback
  const menuItems = useMemo(
    () => createUserMenuItems({ onSignOut }),
    [onSignOut],
  );

  return (
    <UserMenu
      trigger={
        <button
          className={cn(
            // Compact sizing: work-first philosophy - minimize UI chrome
            "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors",
            "hover:bg-sidebar-accent focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none",
            className,
          )}
        >
          <UserAvatar
            avatarUrl={profile.avatarUrl}
            name={profile.name}
            email={profile.email}
            size="xs"
          />
          {showName && (
            <span className="flex-1 truncate text-xs">
              {profile.name ?? profile.email}
            </span>
          )}
        </button>
      }
      items={menuItems}
      side={menuSide}
      align="start"
    />
  );
}
