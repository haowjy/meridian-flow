import { t } from "@lingui/core/macro";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { initialsFromName } from "@/features/account/initials";
import { useSettingsNavigation } from "@/features/account/SettingsDialog";
import { cn } from "@/lib/utils";

export function AccountMenu() {
  const { user, loading } = useAuth();
  const { open } = useSettingsNavigation();

  const email = user?.email ?? null;
  const label = email ?? t`Signed in`;
  const initials = initialsFromName(user?.firstName, user?.lastName, email);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        className={cn(
          "focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
          "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
        )}
        aria-label={t`Account menu`}
        disabled={loading}
      >
        <span
          className="grid size-7 shrink-0 place-items-center rounded-full bg-sidebar-accent text-xs font-medium text-foreground"
          aria-hidden
        >
          {initials}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel className="truncate">{email ?? t`Signed in`}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => open("profile")}>{t`Profile`}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open()}>{t`Settings`}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/logout">{t`Log out`}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
