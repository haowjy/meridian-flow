import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { createClient } from "@/core/supabase/client";
import { LoginForm } from "@/features/auth/components/LoginForm";
import { Logo } from "@/shared/components";

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    // Already logged in -> redirect to projects
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session) {
      throw redirect({ to: "/projects" });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-start p-6 pt-12">
      {/* Logo */}
      <div className="mb-4">
        <Logo size={44} />
      </div>

      {/* Login form */}
      <LoginForm />

      {/* Footer */}
      <p className="text-muted-foreground mt-5 text-xs">
        Your writing workspace
      </p>
      <div className="text-muted-foreground mt-2 flex items-center gap-2 text-xs">
        <Link to="/privacy" className="hover:text-foreground transition-colors">
          Privacy
        </Link>
        <span>·</span>
        <Link to="/terms" className="hover:text-foreground transition-colors">
          Terms
        </Link>
      </div>
    </div>
  );
}
