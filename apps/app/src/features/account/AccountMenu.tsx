import type { User } from "@supabase/supabase-js";

export function AccountMenu({ user }: { user?: Pick<User, "email"> | null }) {
  return <div className="text-sm text-muted-foreground">{user?.email ?? "Signed in"}</div>;
}
