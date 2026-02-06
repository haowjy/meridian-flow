import { useNavigate } from "@tanstack/react-router";
import { Home, LogOut } from "lucide-react";
import { Sheet, SheetContent } from "@/shared/components/ui/sheet";
import { Button } from "@/shared/components/ui/button";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/shared/components/ui/avatar";
import { useUserProfile } from "@/features/auth/hooks/useUserProfile";
import { useAuthActions } from "@/features/auth/hooks/useAuthActions";

interface MobileMenuSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inWorkspace?: boolean;
}

export function MobileMenuSheet({
  open,
  onOpenChange,
  inWorkspace = false,
}: MobileMenuSheetProps) {
  const navigate = useNavigate();
  const { profile } = useUserProfile();
  const { signOut } = useAuthActions();

  const handleNavigate = (to: string) => {
    onOpenChange(false);
    navigate({ to });
  };

  const handleSignOut = () => {
    onOpenChange(false);
    signOut();
  };

  const getInitials = (name?: string | null) => {
    if (!name) return "?";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="p-0">
        {/* Main content - left-aligned column with spacer */}
        <div className="flex h-full flex-col px-4 pt-14 pb-6">
          {/* Top zone - Home button with text (only in workspace) */}
          {inWorkspace && (
            <Button
              variant="ghost"
              className="justify-start"
              onClick={() => handleNavigate("/projects")}
            >
              <Home className="mr-2 size-4" />
              Home
            </Button>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Bottom zone - User info + sign out */}
          <div className="flex flex-col gap-3">
            {profile && (
              <div className="flex items-center gap-3 px-4 py-2">
                <Avatar className="size-10">
                  <AvatarImage src={profile.avatarUrl ?? undefined} />
                  <AvatarFallback className="text-sm">
                    {getInitials(profile.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{profile.name}</p>
                  <p className="text-muted-foreground truncate text-xs">
                    {profile.email}
                  </p>
                </div>
              </div>
            )}
            <Button
              variant="ghost"
              className="justify-start"
              onClick={handleSignOut}
            >
              <LogOut className="mr-2 size-4" />
              Sign Out
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
