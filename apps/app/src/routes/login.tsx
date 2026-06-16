import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getAuth, getSignInUrl } from "@workos/authkit-tanstack-react-start";

import { isDevAutologinEnabled } from "@/server/dev-auth";

const resolveLoginTarget = createServerFn({ method: "GET" })
  .inputValidator((data: { returnPathname: string }) => data)
  .handler(async ({ data }): Promise<{ mode: "dev" } | { mode: "workos"; href: string }> => {
    if (isDevAutologinEnabled()) {
      return { mode: "dev" };
    }
    const href = await getSignInUrl({ data: { returnPathname: data.returnPathname } });
    return { mode: "workos", href };
  });

export const Route = createFileRoute("/login")({
  loader: async ({ location }) => {
    const redirectParam = new URLSearchParams(location.searchStr).get("redirect") ?? undefined;

    const { user } = await getAuth();
    if (user) {
      throw redirect({ to: redirectParam ?? "/" });
    }

    const returnPathname = redirectParam ?? "/";
    const target = await resolveLoginTarget({ data: { returnPathname } });
    return { target, returnPathname };
  },
  component: LoginPage,
});

function LoginPage() {
  const { target } = Route.useLoaderData();

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold text-foreground">Log in to Meridian</h1>
        {target.mode === "dev" ? (
          <>
            <p className="text-sm text-muted-foreground">
              Local development uses the WorkOS test user from your environment.
            </p>
            <p>
              <a className="text-primary underline" href="/dev-login">
                Continue with dev login
              </a>
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Sign in with your Meridian account.</p>
            <p>
              <a className="text-primary underline" href={target.href}>
                Continue to sign in
              </a>
            </p>
          </>
        )}
        <p className="text-sm text-muted-foreground">
          <Link to="/">Back home</Link>
        </p>
      </div>
    </main>
  );
}
