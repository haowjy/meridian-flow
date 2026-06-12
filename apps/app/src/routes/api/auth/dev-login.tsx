// @ts-nocheck
import { createFileRoute } from "@tanstack/react-router";
import {
  currentRequestCookieContext,
  devLoginEnabled,
  serializeSupabaseSessionCookies,
  signInTestUser,
} from "@/server/auth";

export const Route = createFileRoute("/api/auth/dev-login")({
  server: {
    handlers: {
      GET: async () => {
        if (!devLoginEnabled()) {
          return new Response("Not Found", { status: 404 });
        }

        try {
          const session = await signInTestUser();
          const cookieContext = currentRequestCookieContext();
          const headers = new Headers({ Location: "/auth-check" });
          for (const cookie of serializeSupabaseSessionCookies({
            ...session,
            ...cookieContext,
          })) {
            headers.append("Set-Cookie", cookie);
          }
          return new Response(null, { status: 302, headers });
        } catch (error) {
          return new Response(renderDevLoginFailure(error), {
            status: 401,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
      },
    },
  },
});

function renderDevLoginFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "dev-login failed",
    "================",
    "",
    "Supabase password authentication failed for TEST_USER_EMAIL.",
    `message: ${message}`,
    "",
  ].join("\n");
}
