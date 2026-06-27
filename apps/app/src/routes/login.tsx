import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getAuth, getSignInUrl } from "@workos/authkit-tanstack-react-start";

import { MeridianMark } from "@/components/app/MeridianMark";
import { Button } from "@/components/ui/button";
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
    <main className="flex min-h-svh bg-background">
      <LoginHero />
      <section className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm rounded-lg border border-border bg-card p-9 shadow-card">
          <h1 className="mb-2 text-4xl font-semibold text-foreground">Welcome back</h1>
          {target.mode === "dev" ? (
            <>
              <p className="mb-7 text-sm text-muted-foreground">
                Local development signs in as the WorkOS test user from your environment.
              </p>
              <Button asChild className="w-full">
                <a href="/dev-login">Continue with dev login</a>
              </Button>
            </>
          ) : (
            <>
              <p className="mb-7 text-sm text-muted-foreground">
                Sign in to keep writing where you left off.
              </p>
              <Button asChild className="w-full">
                <a href={target.href}>Continue to sign in</a>
              </Button>
            </>
          )}
          <p className="mt-6 text-center text-sm text-muted-foreground">
            <Link to="/" className="text-jade-text underline-offset-2 hover:underline">
              Back home
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}

/** Branded ink hero — deep ground, glowing needle, wordmark, and a corner seal. */
function LoginHero() {
  return (
    <section className="relative hidden w-[55%] flex-col justify-center overflow-hidden bg-ink-deep px-14 py-16 lg:flex">
      <div
        aria-hidden
        className="login-hero-glow pointer-events-none absolute left-14 top-1/2 size-52 -translate-y-[58%]"
      />
      <svg
        aria-hidden="true"
        role="presentation"
        viewBox="0 0 800 400"
        preserveAspectRatio="xMidYMax slice"
        fill="none"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] w-full"
      >
        <path
          d="M0 400 L0 280 C80 240 140 200 220 180 C300 160 360 200 440 150 C520 100 600 180 680 140 C740 110 780 160 800 120 L800 400 Z"
          className="fill-primary opacity-[0.14]"
        />
        <path
          d="M0 400 L0 320 C120 290 200 260 320 250 C440 240 500 280 620 230 C700 200 760 260 800 220 L800 400 Z"
          className="fill-foreground opacity-40"
        />
      </svg>

      <div className="relative z-10">
        <MeridianMark className="login-needle-glow mb-7 size-24" />
        <h2 className="mb-4 text-6xl font-semibold tracking-tight text-cream">Meridian</h2>
        <p className="max-w-[32ch] text-2xl font-medium italic leading-relaxed text-cream-muted">
          Get the story out of your head and onto the page.
        </p>
      </div>

      <svg
        aria-hidden="true"
        role="presentation"
        viewBox="0 0 52 52"
        fill="none"
        className="absolute bottom-12 right-12 size-14 -rotate-6"
      >
        <rect
          x="4"
          y="4"
          width="44"
          height="44"
          rx="3"
          className="fill-cinnabar/15 stroke-cinnabar"
          strokeWidth="2"
        />
        <text x="26" y="34" textAnchor="middle" className="fill-cinnabar text-[22px] font-semibold">
          流
        </text>
      </svg>
    </section>
  );
}
