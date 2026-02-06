import {
  createFileRoute,
  useRouter,
  useCanGoBack,
  Link,
} from "@tanstack/react-router";
import { ArrowLeft, LogOut } from "lucide-react";
import { useUserProfile, useAuthActions, UserAvatar } from "@/features/auth";
import { Button } from "@/shared/components/ui/button";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const { profile, status } = useUserProfile();
  const { signOut } = useAuthActions();

  // Loading state - show empty container
  if (status === "loading") {
    return <div className="container mx-auto max-w-2xl p-8" />;
  }

  // Should not happen if auth guard is working, but handle gracefully
  if (status === "unauthenticated" || !profile) {
    return (
      <div className="container mx-auto max-w-2xl p-8">
        <p className="text-muted-foreground">
          Please sign in to view settings.
        </p>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-2xl p-8">
      {/* Back button - respects navigation history */}
      <button
        onClick={() => {
          if (canGoBack) {
            router.history.back();
          } else {
            // Fallback to /projects since / redirects there anyway
            router.navigate({ to: "/projects" });
          }
        }}
        className="type-label text-muted-foreground hover:text-foreground mb-8 inline-flex items-center gap-2 transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back
      </button>

      {/* Page title */}
      <h1 className="type-display mb-8">Settings</h1>

      {/* Account section */}
      <section
        className="border-border bg-card rounded-lg border p-6"
        style={{ boxShadow: "var(--shadow-1)" }}
      >
        <h2 className="type-label text-muted-foreground mb-4 tracking-wide uppercase">
          Account
        </h2>

        <div className="flex items-center gap-4">
          <UserAvatar
            avatarUrl={profile.avatarUrl}
            name={profile.name}
            email={profile.email}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <p className="type-section truncate">{profile.name ?? "No name"}</p>
            <p className="type-meta truncate">{profile.email}</p>
          </div>
        </div>

        <div className="border-border mt-6 border-t pt-6">
          <Button variant="outline" onClick={signOut} className="gap-2">
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </section>

      {/* Legal section */}
      <section
        className="border-border bg-card mt-6 rounded-lg border p-6"
        style={{ boxShadow: "var(--shadow-1)" }}
      >
        <h2 className="type-label text-muted-foreground mb-4 tracking-wide uppercase">
          Legal
        </h2>
        <div className="flex flex-col gap-2">
          <Link
            to="/privacy"
            className="type-body text-muted-foreground hover:text-foreground transition-colors"
          >
            Privacy Policy
          </Link>
          <Link
            to="/terms"
            className="type-body text-muted-foreground hover:text-foreground transition-colors"
          >
            Terms of Service
          </Link>
        </div>
      </section>
    </div>
  );
}
